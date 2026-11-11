import { BrowserWindow } from 'electron'
import type {
  EtapaSync,
  ShopeeConnectionStatus,
  SyncResult,
  TrackingRefreshResult
} from '@shared/types'
import {
  fetchOrderIncome,
  fetchLabelGeneratedAt,
  fetchOrders,
  fetchOrdersByIds,
  fetchProducts,
  fetchRatings,
  fetchTrackingInfo,
  normalizeCard
} from './client'
import type { FetchOrdersOptions, NormalizedShopeeOrder } from './client'
import { getAsyncDb } from '../../db'
import { isConnected } from './session'
import {
  getOrderAsync,
  listOpenShopeeOrderIdsAsync,
  listOrdersMissingLabelDateAsync,
  saveLabelDatesAsync,
  setRatingAsync,
  upsertShopeeOrderAsync
} from '../orders'
import { recordEventAsync } from '../events'
import { pedidosParaAtualizarPagamentoAsync, salvarRecebimentoAsync } from '../recebimentos'
import { saveOrderDump } from '../orderDump'
import {
  recomporCatalogoDosPedidosAsync,
  salvarProdutoShopeeAsync
} from '../produtos'
import { baixarEstoqueDosDespachadosAsync } from '../receitas'
import { assertCurrentShopeeAccount } from './accountBinding'
import { listSentTrackingTargets, saveTrackingCheckpoints, syncHistoricalTracking, type TrackingTarget } from './trackingHistory'

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const state: ShopeeConnectionStatus = {
  connected: false,
  shopName: null,
  lastSyncAt: null,
  lastSyncError: null,
  syncing: false
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export async function getConnectionStatus(): Promise<ShopeeConnectionStatus> {
  state.connected = await isConnected()
  return { ...state }
}

/** Consulta somente etiquetas recentes ainda sem data, e grava tudo em um lote no Turso. */
export async function syncRecentLabelDates(
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean
): Promise<{ updated: number; failed: number }> {
  const missing = await listOrdersMissingLabelDateAsync()
  const dates: { orderSn: string; generatedAt: number }[] = []
  let failed = 0
  for (const [index, order] of missing.entries()) {
    if (shouldCancel?.()) break
    try {
      const generatedAt = await fetchLabelGeneratedAt(order.orderId)
      if (generatedAt) dates.push({ orderSn: order.orderSn, generatedAt })
    } catch { failed++ }
    onProgress?.(index + 1, missing.length)
    await sleep(150)
  }
  await saveLabelDatesAsync(dates)
  return { updated: dates.length, failed }
}

/** Uma leitura remota compara os cards com os pedidos já salvos. */
async function changedOrders(orders: NormalizedShopeeOrder[]): Promise<NormalizedShopeeOrder[]> {
  if (orders.length === 0) return []
  const db = getAsyncDb()
  const saved = new Map<string, { raw_json: string | null; tab: string | null }>()
  for (let start = 0; start < orders.length; start += 100) {
    const sns = orders.slice(start, start + 100).map((order) => order.orderSn)
    const rows = await (await db.prepare(`SELECT order_sn,raw_json,tab FROM orders
      WHERE order_sn IN (${sns.map(() => '?').join(',')})`)).all(sns) as {
      order_sn: string; raw_json: string | null; tab: string | null
    }[]
    for (const row of rows) saved.set(row.order_sn, row)
  }
  return orders.filter((order) => {
    const previous = saved.get(order.orderSn)
    if (!previous?.raw_json || (order.shopeeTab && previous.tab !== order.shopeeTab)) return true
    try {
      const old = normalizeCard(JSON.parse(previous.raw_json))
      if (!old) return true
      const comparable = (value: NormalizedShopeeOrder): string =>
        JSON.stringify({ ...value, rawJson: null, shopeeTab: null })
      return comparable(old) !== comparable(order)
    } catch {
      return true
    }
  })
}

/** O card não traz a hora real da venda; o primeiro evento do extrato traz. */
async function syncEstimatedSaleDates(
  orders: NormalizedShopeeOrder[], shouldCancel: () => boolean
): Promise<{ checked: number; corrected: number; failed: number }> {
  const estimated = new Map(orders.filter((order) => order.createdAtEstimated && order.shopeeOrderId)
    .map((order) => [order.orderSn, order.shopeeOrderId!] as const))
  if (estimated.size === 0) return { checked: 0, corrected: 0, failed: 0 }
  const candidates: { order_sn: string }[] = []
  const sns = [...estimated.keys()]
  for (let start = 0; start < sns.length; start += 100) {
    const part = sns.slice(start, start + 100)
    const rows = await (await getAsyncDb().prepare(`SELECT o.order_sn FROM orders o
      LEFT JOIN order_income i ON i.order_sn=o.order_sn
      WHERE o.order_sn IN (${part.map(() => '?').join(',')})
        AND o.tab NOT IN ('CANCELADO','NAO_PAGO') AND i.order_sn IS NULL`)).all(part) as { order_sn: string }[]
    candidates.push(...rows)
  }
  if (candidates.length === 0) return { checked: 0, corrected: 0, failed: 0 }
  iniciaEtapa('datas', candidates.length)
  let checked = 0
  let corrected = 0
  let failed = 0
  for (const row of candidates) {
    if (shouldCancel()) break
    try {
      const income = await fetchOrderIncome(row.order_sn, estimated.get(row.order_sn)!)
      if (income?.criadoEm) {
        await salvarRecebimentoAsync(income)
        corrected++
      } else {
        failed++
      }
    } catch {
      failed++
    }
    checked++
    avancaEtapa()
    await sleep(150)
  }
  return { checked, corrected, failed }
}

export async function syncAll(opts: { todasAsPaginas?: boolean; pendingOnly?: boolean; pages?: number } = {}): Promise<SyncResult> {
  const pages = opts.pages ?? 2
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 100) {
    throw new Error('Informe entre 1 e 100 páginas para sincronizar.')
  }
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
  Object.assign(lote, { novos: 0, rastreiosPendentes: null, recebimentosPendentes: null })
  broadcast('shopee:status-changed', await getConnectionStatus())

  const result: SyncResult = {
    ok: true,
    ordersUpserted: 0,
    newOrders: 0,
    eventsCreated: 0,
    error: null
  }
  const errors: string[] = []
  const touchedOrders = new Set<string>()
  let ordersWithEstimatedDates: NormalizedShopeeOrder[] = []

  try {
    if (!(await isConnected())) {
      throw new Error('Não conectado à Shopee. Abra Configurações e faça login no Seller Center.')
    }
    await assertCurrentShopeeAccount()

    // Pedidos
    try {
      console.log(`[sync] pedidos: ${opts.todasAsPaginas ? 'histórico completo' : opts.pendingOnly ? 'pendentes locais' : 'duas páginas recentes'}`)
      const orderOptions: FetchOrdersOptions = {
        maxPages: opts.todasAsPaginas ? null : pages,
        onCard: opts.todasAsPaginas ? (orderId, card) => saveOrderDump(orderId, card) : undefined,
        onOrder: opts.todasAsPaginas ? async (order) => {
          if (lote.cancelar) return
          const isNew = await upsertShopeeOrderAsync(order)
          touchedOrders.add(order.orderSn)
          result.ordersUpserted++
          if (isNew) {
            result.newOrders++
            lote.novos++
          }
          await yieldToEventLoop()
        } : undefined,
        shouldCancel: () => lote.cancelar,
        onProgress: (feitos, total) => {
          if (lote.rotulo !== 'pedidos') iniciaEtapa('pedidos', total ?? feitos)
          lote.feitos = feitos
          lote.total = total ?? feitos
          emiteProgresso()
        }
      }
      if (opts.todasAsPaginas) {
        await fetchOrders(orderOptions)
      } else {
        const orders = opts.pendingOnly
          ? await fetchOrdersByIds(await listOpenShopeeOrderIdsAsync(), orderOptions)
          : await fetchOrders(orderOptions)
        ordersWithEstimatedDates = orders
        for (const order of orders) touchedOrders.add(order.orderSn)
        if (!lote.cancelar) {
          const changed = await changedOrders(orders)
          iniciaEtapa('gravando', changed.length)
          for (const order of changed) {
            if (lote.cancelar) break
            const isNew = await upsertShopeeOrderAsync(order)
            result.ordersUpserted++
            if (isNew) { result.newOrders++; lote.novos++ }
            avancaEtapa()
            await yieldToEventLoop()
          }
        }
      }
    } catch (err) {
      errors.push(String(err instanceof Error ? err.message : err))
    }

    if (!opts.todasAsPaginas && !lote.cancelar) {
      try {
        const dates = await syncEstimatedSaleDates(ordersWithEstimatedDates, () => lote.cancelar)
        if (dates.failed > 0) errors.push(`datas das vendas: ${dates.failed} pedidos sem hora confirmada`)
      } catch (err) {
        errors.push(`datas das vendas: ${String(err instanceof Error ? err.message : err)}`)
      }
    }

    // A data da etiqueta não vem no card. Consulta somente pedidos recentes
    // com etiqueta pronta e data ainda ausente.
    if (!lote.cancelar) {
      try {
        const labels = await syncRecentLabelDates((done, total) => {
          if (lote.rotulo !== 'etiquetas') iniciaEtapa('etiquetas', total)
          lote.feitos = done
          lote.total = total
          emiteProgresso()
        }, () => lote.cancelar)
        if (labels.failed > 0) errors.push(`etiquetas: ${labels.failed} consultas falharam`)
      } catch (err) {
        errors.push(`etiquetas: ${String(err instanceof Error ? err.message : err)}`)
      }
    }

    // Avaliações dos compradores pertencem apenas à carga histórica.
    if (opts.todasAsPaginas) {
      try {
        const ratings = await fetchRatings()
        for (const r of ratings) {
          if (!(await getOrderAsync(r.orderSn))) continue
          await setRatingAsync(r.orderSn, r.star, r.comment, r.ratedAt)
          const stars = '★'.repeat(Math.max(1, Math.min(5, Math.round(r.star))))
          if (
            await recordEventAsync({
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
    }

    if (!lote.cancelar) {

      // Rastreio dos enviados: é o único grupo em movimento — "a enviar" nem saiu
      // e "concluído" já chegou.
      if (!lote.cancelar) {
        try {
          const enviados = (await listSentTrackingTargets()).filter((order) =>
            opts.pendingOnly || opts.todasAsPaginas || touchedOrders.has(order.orderSn))
          lote.rastreiosPendentes = enviados.length
          iniciaEtapa('rastreios', enviados.length)
          let failedTracking = 0
          for (const order of enviados) {
            if (lote.cancelar) break
            const r = await refreshTrackingKnownOrder(order)
            result.eventsCreated += r.newEvents
            if (!r.ok) failedTracking++
            avancaEtapa()
            await sleep(300)
          }
          if (failedTracking > 0) errors.push(`rastreios: ${failedTracking} pedidos não puderam ser consultados`)
        } catch (err) {
          errors.push(`rastreios: ${String(err instanceof Error ? err.message : err)}`)
        }
      }

      // Pedidos recentes já concluídos podem precisar do último rastreio.
      // A rotina de pendentes cuida dos abertos; o histórico amplo fica separado.
      if (!opts.pendingOnly && !lote.cancelar) {
        try {
          const history = await syncHistoricalTracking({
            full: true,
            orderSns: opts.todasAsPaginas ? undefined : touchedOrders,
            shouldCancel: () => lote.cancelar,
            onProgress: (done, total) => {
              if (lote.rotulo !== 'historico') iniciaEtapa('historico', total)
              lote.feitos = done
              lote.total = total
              emiteProgresso()
            }
          })
          result.eventsCreated += history.newEvents
          if (history.failed > 0) errors.push(`histórico: ${history.failed} pedidos não puderam ser consultados`)
          if (history.halted) errors.push('histórico: interrompido após falhas consecutivas da Shopee')
        } catch (err) {
          errors.push(`histórico: ${String(err instanceof Error ? err.message : err)}`)
        }
      }

      // Pagamento: sem extrato, enviados pendentes e concluídos com extrato antigo.
      if (!lote.cancelar) {
        try {
          const pendentes = (await pedidosParaAtualizarPagamentoAsync(!opts.todasAsPaginas))
            .filter((order) => opts.pendingOnly || opts.todasAsPaginas || touchedOrders.has(order.orderSn))
          lote.recebimentosPendentes = pendentes.length
          iniciaEtapa('pagamentos', pendentes.length)
          let failedPayments = 0
          for (const { orderSn, orderId } of pendentes) {
            if (lote.cancelar) break
            try {
              const income = await fetchOrderIncome(orderSn, orderId)
              if (income) {
                await salvarRecebimentoAsync(income)
                if (income.recebidoEm !== null) {
                  const valor =
                    income.valorRecebido !== null ? ` (${BRL.format(income.valorRecebido)})` : ''
                  if (
                    await recordEventAsync({
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
            } catch {
              failedPayments++
            }
            avancaEtapa()
            await sleep(300)
          }
          if (failedPayments > 0) errors.push(`pagamentos: ${failedPayments} pedidos não puderam ser consultados`)
        } catch (err) {
          errors.push(`pagamentos: ${String(err instanceof Error ? err.message : err)}`)
        }
      }
    }

    // As páginas já terminaram, mas ainda há trabalho no banco remoto.
    iniciaEtapa('finalizando', 0)
    // O catálogo sai dos próprios pedidos. A baixa de estoque depende dos
    // eventos logísticos, que a sincronização rápida não consulta.
    try {
      await recomporCatalogoDosPedidosAsync()
      if (opts.todasAsPaginas) await baixarEstoqueDosDespachadosAsync()
    } catch (err) {
      console.warn('[sync] catálogo/estoque:', err)
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
    broadcast('data:changed', null)
    // A UI recebe primeiro a versão final dos dados e só depois desbloqueia
    // Pedidos. Assim a listagem monta uma única vez, já com o banco estável.
    broadcast('shopee:status-changed', await getConnectionStatus())
  }
  return result
}

export function isSyncing(): boolean {
  return state.syncing
}

/**
 * Estado das operações longas (rastreios / extratos). Guardado aqui porque
 * elas rodam por minutos: a UI precisa saber onde está e poder mandar parar.
 */
interface EstadoProgresso {
  rodando: boolean
  feitos: number
  total: number
  novos: number
  rastreiosPendentes: number | null
  recebimentosPendentes: number | null
  rotulo: EtapaSync | ''
  cancelar: boolean
}

const lote: EstadoProgresso = { rodando: false, feitos: 0, total: 0,
  novos: 0, rastreiosPendentes: null, recebimentosPendentes: null,
  rotulo: '', cancelar: false }

function iniciaEtapa(rotulo: EtapaSync, total: number): void {
  Object.assign(lote, { rodando: true, feitos: 0, total, rotulo })
  emiteProgresso()
}

function avancaEtapa(): void {
  lote.feitos++
  emiteProgresso()
}

function encerraProgresso(): void {
  Object.assign(lote, { rodando: false, feitos: 0, total: 0, rotulo: '', cancelar: false,
    novos: 0, rastreiosPendentes: null, recebimentosPendentes: null })
  emiteProgresso()
}

function emiteProgresso(): void {
  broadcast('lote:progresso', { ...lote, cancelar: undefined })
}

export function progressoLote(): Omit<EstadoProgresso, 'cancelar'> {
  return { rodando: lote.rodando, feitos: lote.feitos, total: lote.total, rotulo: lote.rotulo,
    novos: lote.novos, rastreiosPendentes: lote.rastreiosPendentes,
    recebimentosPendentes: lote.recebimentosPendentes }
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
    await assertCurrentShopeeAccount()
    const order = await getOrderAsync(orderSn)
    if (!order?.shopeeOrderId) throw new Error(`Pedido ${orderSn} sem id da Shopee`)
    const income = await fetchOrderIncome(orderSn, order.shopeeOrderId)
    if (!income) throw new Error('A Shopee não devolveu extrato para este pedido.')
    await salvarRecebimentoAsync(income)
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
    await assertCurrentShopeeAccount()
    const order = await getOrderAsync(orderSn)
    if (!order) throw new Error(`Pedido ${orderSn} não encontrado`)
    const result = await refreshTrackingKnownOrder(order)
    if (result.ok) broadcast('data:changed', null)
    return result
  } catch (err) {
    return {
      ok: false,
      newEvents: 0,
      latestStatus: null,
      error: String(err instanceof Error ? err.message : err)
    }
  }
}

async function refreshTrackingKnownOrder(order: TrackingTarget): Promise<TrackingRefreshResult> {
  try {
    const checkpoints = await fetchTrackingInfo(order.orderSn, order.shopeeOrderId)
    if (checkpoints.length === 0) {
      return { ok: true, newEvents: 0, latestStatus: order.logisticsStatus, error: null }
    }
    const saved = await saveTrackingCheckpoints(order.orderSn, checkpoints)
    return { ok: true, newEvents: saved.newEvents, latestStatus: saved.latestStatus, error: null }
  } catch (err) {
    return { ok: false, newEvents: 0, latestStatus: null,
      error: String(err instanceof Error ? err.message : err) }
  }
}

/**
 * Sincroniza o catálogo de produtos.
 *
 * Fica fora do botão Sincronizar de propósito: produto muda de mês em mês, não
 * de hora em hora, e o que interessa no dia a dia (nome, variação, quanto
 * vendeu) já vem dos pedidos.
 */
export async function sincronizarProdutos(): Promise<{
  ok: boolean
  produtos: number
  error?: string
}> {
  try {
    await assertCurrentShopeeAccount()
    const produtos = await fetchProducts()
    for (const p of produtos) await salvarProdutoShopeeAsync(p)
    await recomporCatalogoDosPedidosAsync()
    broadcast('data:changed', null)
    return { ok: true, produtos: produtos.length }
  } catch (err) {
    return { ok: false, produtos: 0, error: String(err instanceof Error ? err.message : err) }
  }
}
