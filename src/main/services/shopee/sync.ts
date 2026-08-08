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
  listAwaitingPayment,
  setEscrow,
  setLogisticsStatus,
  setRating,
  upsertShopeeOrder
} from '../orders'
import { recordEvent } from '../events'
import { phaseFromCheckpoints } from '../phases'
import { getSettings } from '../settings'
import { saveOrderDump } from '../orderDump'

/** Palavras que indicam entrega concluída num checkpoint de rastreio. */
const DELIVERED_PATTERN = /entregue|delivered|entrega realizada/i

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * Quantos extratos financeiros buscar por sincronização. O endpoint é por
 * pedido: sem teto, cada sync viraria centenas de chamadas. O que sobra entra
 * na rodada seguinte.
 */
const INCOME_PER_SYNC = 15

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
        setEscrow(order.orderSn, income.sellerIncome, income.releasedAt)
        if (income.releasedAt !== null) {
          const valor = income.sellerIncome !== null ? ` (${BRL.format(income.sellerIncome)})` : ''
          if (
            recordEvent({
              orderSn: order.orderSn,
              source: 'finance',
              description: `Pagamento liberado${valor}`,
              happenedAt: income.releasedAt,
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
    const phase = phaseFromCheckpoints(checkpoints.map((c) => c.description))
    setLogisticsStatus(orderSn, latest.description, delivered?.happenedAt ?? null, phase)

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
