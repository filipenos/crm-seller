import { BrowserWindow } from 'electron'
import type { ShopeeConnectionStatus, SyncResult, TrackingRefreshResult } from '@shared/types'
import {
  fetchOrderIncome,
  fetchOrders,
  fetchRatings,
  fetchTrackingInfo
} from './client'
import { isConnected } from './session'
import {
  countAwaitingPayment,
  getOrder,
  listOrders,
  listAwaitingPayment,
  setEscrow,
  setLogisticsStatus,
  setRating,
  upsertShopeeOrder
} from '../orders'
import { recordEvent } from '../events'
import { pedidosParaExtrato, salvarRecebimento } from '../recebimentos'
import { getSettings } from '../settings'
import { saveOrderDump } from '../orderDump'

/** Palavras que indicam entrega concluída num checkpoint de rastreio. */
const DELIVERED_PATTERN = /entregue|delivered|entrega realizada/i

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * Quantos extratos financeiros buscar por sincronização.
 *
 * O endpoint é por pedido, mas só precisa rodar em quem está entre a postagem
 * e o pagamento — na conta real, 26 pedidos. O teto cobre esse conjunto de uma
 * vez sem virar centenas de chamadas; o que sobrar entra na rodada seguinte.
 */
const INCOME_PER_SYNC = 30

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const state: ShopeeConnectionStatus = {
  connected: false,
  shopName: null,
  lastSyncAt: null,
  lastSyncError: null,
  syncing: false
}

let timer: NodeJS.Timeout | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export async function getConnectionStatus(): Promise<ShopeeConnectionStatus> {
  state.connected = await isConnected()
  return { ...state }
}

export async function syncAll(opts: { todasAsPaginas?: boolean } = {}): Promise<SyncResult> {
  if (state.syncing) {
    return {
      ok: false,
      ordersUpserted: 0,
      newOrders: 0,
        eventsCreated: 0,
      error: 'Sincronização já em andamento'
    }
  }
  state.syncing = true
  broadcast('shopee:status-changed', await getConnectionStatus())

  const result: SyncResult = {
    ok: true,
    ordersUpserted: 0,
    newOrders: 0,
    eventsCreated: 0,
    error: null
  }
  const errors: string[] = []

  try {
    if (!(await isConnected())) {
      throw new Error('Não conectado à Shopee. Abra Configurações e faça login no Seller Center.')
    }

    // Pedidos
    try {
      const paginas = opts.todasAsPaginas ? null : Math.max(1, getSettings().syncPageCount)
      console.log(`[sync] pedidos: ${paginas === null ? 'todas as páginas' : paginas + ' página(s)'}`)
      const orders = await fetchOrders({
        maxPages: paginas,
        onCard: (orderId, card) => saveOrderDump(orderId, card),
        onProgress: (feitos, total) => {
          if (feitos % 50 === 0 || feitos === total) console.log(`[sync] cards ${feitos}/${total}`)
        }
      })
      for (const o of orders) {
        const isNew = upsertShopeeOrder(o)
        result.ordersUpserted++
        if (isNew) result.newOrders++
      }
    } catch (err) {
      errors.push(String(err instanceof Error ? err.message : err))
    }

    // Avaliações dos compradores
    try {
      const ratings = await fetchRatings()
      for (const r of ratings) {
        if (!getOrder(r.orderSn)) continue
        setRating(r.orderSn, r.star, r.comment, r.ratedAt)
        const stars = '★'.repeat(Math.max(1, Math.min(5, Math.round(r.star))))
        if (
          recordEvent({
            orderSn: r.orderSn,
            source: 'rating',
            description: `Pedido avaliado com ${stars} (${r.star})${r.comment ? `: “${r.comment}”` : ''}`,
            happenedAt: r.ratedAt ?? Date.now(),
            rawJson: r.rawJson
          })
        ) {
          result.eventsCreated++
        }
      }
    } catch (err) {
      errors.push(`avaliações: ${String(err instanceof Error ? err.message : err)}`)
    }

    // Financeiro — o extrato é por pedido, então consultamos só os que ainda
    // esperam pagamento, e um número limitado por vez. Sem esse teto, uma
    // sincronização viraria centenas de chamadas.
    try {
      const pendentes = listAwaitingPayment(INCOME_PER_SYNC)
      for (const order of pendentes) {
        if (!order.shopeeOrderId) continue
        const income = await fetchOrderIncome(order.orderSn, order.shopeeOrderId)
        if (!income) continue
        salvarRecebimento(income)
        if (income.recebidoEm !== null) {
          const valor = income.valorRecebido !== null ? ` (${BRL.format(income.valorRecebido)})` : ''
          if (
            recordEvent({
              orderSn: order.orderSn,
              source: 'finance',
              description: `Pagamento liberado${valor}`,
              happenedAt: income.recebidoEm,
              rawJson: income.rawJson
            })
          ) {
            result.eventsCreated++
          }
        }
        await sleep(300)
      }
      const restantes = countAwaitingPayment() - pendentes.length
      if (restantes > 0) {
        console.log(`[sync] financeiro: ${restantes} pedidos ficaram para a próxima rodada`)
      }
    } catch (err) {
      errors.push(`financeiro: ${String(err instanceof Error ? err.message : err)}`)
    }

    state.lastSyncAt = Date.now()
    if (errors.length > 0) {
      result.ok =
        result.ordersUpserted > 0 || result.eventsCreated > 0
      result.error = errors.join(' | ')
    }
    state.lastSyncError = result.error
  } catch (err) {
    result.ok = false
    result.error = String(err instanceof Error ? err.message : err)
    state.lastSyncError = result.error
  } finally {
    console.log(
      `[sync] pedidos=${result.ordersUpserted} (novos=${result.newOrders}) eventos=${result.eventsCreated}`
    )
    if (result.error) console.error('[sync] erros:', result.error)
    state.syncing = false
    broadcast('shopee:status-changed', await getConnectionStatus())
    broadcast('data:changed', null)
  }
  return result
}

/**
 * Estado das operações longas (rastreios / extratos). Guardado aqui porque
 * elas rodam por minutos: a UI precisa saber onde está e poder mandar parar.
 */
interface ProgressoLote {
  rodando: boolean
  feitos: number
  total: number
  rotulo: string
  cancelar: boolean
}

const lote: ProgressoLote = { rodando: false, feitos: 0, total: 0, rotulo: '', cancelar: false }

function emiteProgresso(): void {
  broadcast('lote:progresso', { ...lote, cancelar: undefined })
}

export function progressoLote(): Omit<ProgressoLote, 'cancelar'> {
  return { rodando: lote.rodando, feitos: lote.feitos, total: lote.total, rotulo: lote.rotulo }
}

export function cancelarLote(): void {
  if (lote.rodando) lote.cancelar = true
}

/**
 * Roda uma operação por pedido, avisando o progresso e parando quando pedido.
 *
 * O intervalo entre chamadas existe porque são APIs internas sem cota
 * publicada — centenas de requisições em rajada é o tipo de coisa que chama
 * atenção.
 */
async function rodarLote<T>(
  rotulo: string,
  itens: T[],
  passo: (item: T) => Promise<void>
): Promise<{ feitos: number; cancelado: boolean; erros: number }> {
  if (lote.rodando) throw new Error('Já existe uma operação em andamento.')
  Object.assign(lote, { rodando: true, feitos: 0, total: itens.length, rotulo, cancelar: false })
  emiteProgresso()

  let erros = 0
  try {
    for (const item of itens) {
      if (lote.cancelar) break
      try {
        await passo(item)
      } catch (err) {
        erros++
        console.warn(`[${rotulo}] falhou:`, err)
      }
      lote.feitos++
      emiteProgresso()
      await sleep(300)
    }
    return { feitos: lote.feitos, cancelado: lote.cancelar, erros }
  } finally {
    lote.rodando = false
    emiteProgresso()
    broadcast('data:changed', null)
  }
}

/** Atualiza o rastreio de todos os pedidos de uma aba. */
export async function atualizarRastreios(tab: string): Promise<{
  feitos: number
  cancelado: boolean
  erros: number
}> {
  const pedidos = listOrders({ tab: tab as never }).filter((o) => o.shopeeOrderId)
  return rodarLote('rastreios', pedidos, async (o) => {
    await refreshTracking(o.orderSn)
  })
}

/**
 * Busca o extrato dos pedidos de uma aba. Por padrão só de quem não tem —
 * valor de pedido concluído não muda, então refazer é desperdício.
 */
export async function buscarExtratos(
  tab: string,
  refazer = false
): Promise<{ feitos: number; cancelado: boolean; erros: number }> {
  const pendentes = pedidosParaExtrato(tab, { refazer })
  return rodarLote('extratos', pendentes, async ({ orderSn, orderId }) => {
    const extrato = await fetchOrderIncome(orderSn, orderId)
    if (extrato) salvarRecebimento(extrato)
  })
}

/**
 * Atualiza o rastreio de UM pedido, sob demanda (botão na UI).
 * Registra os checkpoints novos como eventos e atualiza o status logístico.
 */
export async function refreshTracking(orderSn: string): Promise<TrackingRefreshResult> {
  try {
    if (!(await isConnected())) {
      throw new Error('Não conectado à Shopee. Faça login em Configurações.')
    }
    const order = getOrder(orderSn)
    if (!order) throw new Error(`Pedido ${orderSn} não encontrado`)

    const checkpoints = await fetchTrackingInfo(order.orderSn, order.shopeeOrderId)
    if (checkpoints.length === 0) {
      return { ok: true, newEvents: 0, latestStatus: order.logisticsStatus, error: null }
    }
    const latest = checkpoints.reduce((a, b) => (a.happenedAt > b.happenedAt ? a : b))
    const delivered = checkpoints.find((c) => DELIVERED_PATTERN.test(c.description))
    setLogisticsStatus(orderSn, latest.description, delivered?.happenedAt ?? null)

    let newEvents = 0
    for (const c of checkpoints) {
      if (
        recordEvent({
          orderSn,
          source: 'logistics',
          description: c.description,
          happenedAt: c.happenedAt,
          rawJson: c.rawJson
        })
      ) {
        newEvents++
      }
    }
    broadcast('data:changed', null)
    return { ok: true, newEvents, latestStatus: latest.description, error: null }
  } catch (err) {
    return {
      ok: false,
      newEvents: 0,
      latestStatus: null,
      error: String(err instanceof Error ? err.message : err)
    }
  }
}

/**
 * Agendador da sincronização. Só liga quando o usuário pede explicitamente
 * (`autoSyncEnabled`); o padrão é sincronizar apenas pelo botão.
 */
export function startSyncScheduler(): void {
  stopSyncScheduler()
  const settings = getSettings()
  if (!settings.autoSyncEnabled) {
    console.log('[sync] automático desligado — sincronize pelo botão')
    return
  }
  const minutes = Math.max(1, settings.syncIntervalMinutes)
  console.log(`[sync] automático ligado, a cada ${minutes} min`)
  timer = setInterval(() => {
    void syncAll()
  }, minutes * 60 * 1000)
}

export function stopSyncScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
