import { BrowserWindow } from 'electron'
import type {
  EtapaSync,
  ShopeeConnectionStatus,
  SyncResult,
  TrackingRefreshResult
} from '@shared/types'
import {
  fetchOrderIncome,
  fetchOrders,
  fetchRatings,
  fetchTrackingInfo
} from './client'
import { isConnected } from './session'
import {
  getOrder,
  listOrders,
  setLogisticsStatus,
  setRating,
  upsertShopeeOrder
} from '../orders'
import { recordEvent } from '../events'
import { pedidosParaAtualizarPagamento, salvarRecebimento } from '../recebimentos'
import { getSettings } from '../settings'
import { saveOrderDump } from '../orderDump'

/** Palavras que indicam entrega concluída num checkpoint de rastreio. */
const DELIVERED_PATTERN = /entregue|delivered|entrega realizada/i

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

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
          if (lote.rotulo !== 'pedidos') iniciaEtapa('pedidos', total ?? feitos)
          lote.feitos = feitos
          lote.total = total ?? feitos
          emiteProgresso()
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

    const config = getSettings()

    // Rastreio dos enviados: é o único grupo em movimento — "a enviar" nem saiu
    // e "concluído" já chegou.
    if (config.syncTracking && !lote.cancelar) {
      try {
        const enviados = listOrders({ tab: 'ENVIADO' }).filter((o) => o.shopeeOrderId)
        iniciaEtapa('rastreios', enviados.length)
        for (const order of enviados) {
          if (lote.cancelar) break
          try {
            const r = await refreshTracking(order.orderSn)
            if (r.newEvents > 0) result.eventsCreated += r.newEvents
          } catch (err) {
            console.warn(`[sync] rastreio ${order.orderSn}:`, err)
          }
          avancaEtapa()
          await sleep(300)
        }
      } catch (err) {
        errors.push(`rastreios: ${String(err instanceof Error ? err.message : err)}`)
      }
    }

    // Pagamento: quem não tem extrato, e os enviados cujo dinheiro ainda não
    // caiu — esses mudam sozinhos quando a Shopee libera.
    if (config.syncPayments && !lote.cancelar) {
      try {
        const pendentes = pedidosParaAtualizarPagamento()
        iniciaEtapa('pagamentos', pendentes.length)
        for (const { orderSn, orderId } of pendentes) {
          if (lote.cancelar) break
          try {
            const income = await fetchOrderIncome(orderSn, orderId)
            if (income) {
              salvarRecebimento(income)
              if (income.recebidoEm !== null) {
                const valor =
                  income.valorRecebido !== null ? ` (${BRL.format(income.valorRecebido)})` : ''
                if (
                  recordEvent({
                    orderSn,
                    source: 'finance',
                    description: `Pagamento liberado${valor}`,
                    happenedAt: income.recebidoEm,
                    rawJson: income.rawJson
                  })
                ) {
                  result.eventsCreated++
                }
              }
            }
          } catch (err) {
            console.warn(`[sync] extrato ${orderSn}:`, err)
          }
          avancaEtapa()
          await sleep(300)
        }
      } catch (err) {
        errors.push(`pagamentos: ${String(err instanceof Error ? err.message : err)}`)
      }
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
    encerraProgresso()
    broadcast('shopee:status-changed', await getConnectionStatus())
    broadcast('data:changed', null)
  }
  return result
}

/**
 * Estado das operações longas (rastreios / extratos). Guardado aqui porque
 * elas rodam por minutos: a UI precisa saber onde está e poder mandar parar.
 */
interface EstadoProgresso {
  rodando: boolean
  feitos: number
  total: number
  rotulo: EtapaSync | ''
  cancelar: boolean
}

const lote: EstadoProgresso = { rodando: false, feitos: 0, total: 0, rotulo: '', cancelar: false }

function iniciaEtapa(rotulo: EtapaSync, total: number): void {
  Object.assign(lote, { rodando: true, feitos: 0, total, rotulo })
  emiteProgresso()
}

function avancaEtapa(): void {
  lote.feitos++
  emiteProgresso()
}

function encerraProgresso(): void {
  Object.assign(lote, { rodando: false, feitos: 0, total: 0, rotulo: '', cancelar: false })
  emiteProgresso()
}

function emiteProgresso(): void {
  broadcast('lote:progresso', { ...lote, cancelar: undefined })
}

export function progressoLote(): Omit<EstadoProgresso, 'cancelar'> {
  return { rodando: lote.rodando, feitos: lote.feitos, total: lote.total, rotulo: lote.rotulo }
}

export function cancelarLote(): void {
  if (lote.rodando) lote.cancelar = true
}

/** Atualiza o extrato de UM pedido, sob demanda (botão no detalhe). */
export async function refreshIncome(orderSn: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!(await isConnected())) {
      throw new Error('Não conectado à Shopee. Faça login em Configurações.')
    }
    const order = getOrder(orderSn)
    if (!order?.shopeeOrderId) throw new Error(`Pedido ${orderSn} sem id da Shopee`)
    const income = await fetchOrderIncome(orderSn, order.shopeeOrderId)
    if (!income) throw new Error('A Shopee não devolveu extrato para este pedido.')
    salvarRecebimento(income)
    broadcast('data:changed', null)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
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
