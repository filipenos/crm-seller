import { createHash } from 'node:crypto'
import { getAsyncDb } from '../../db'
import { fetchLabelGeneratedAt, fetchTrackingInfo, type TrackingCheckpoint } from './client'

interface Candidate {
  order_sn: string
  shopee_order_id: string
  label_generated_at: number | null
}

export interface TrackingTarget {
  orderSn: string
  shopeeOrderId: string | null
  logisticsStatus: string | null
}

type Write = { sql: string; parameters: unknown[] }
const BATCH_SIZE = 10

function trackingWrites(
  orderSn: string,
  checkpoints: TrackingCheckpoint[],
  fallbackLabel: number | null,
  audit: boolean
): { writes: Write[]; eventPositions: number[]; latestStatus: string | null } {
  const writes: Write[] = []
  const eventPositions: number[] = []
  const latest = checkpoints.reduce<TrackingCheckpoint | null>(
    (current, item) => !current || item.happenedAt > current.happenedAt ? item : current, null)
  const delivered = checkpoints.find((item) => /entregue|delivered|entrega realizada/i.test(item.description))
  const label = checkpoints.find((item) => item.description.trim().toLocaleLowerCase('pt-BR') === 'pedido em preparação')
  if (latest || label || fallbackLabel) {
    writes.push({ sql: `UPDATE orders SET logistics_status=COALESCE(?,logistics_status),
      delivered_at=COALESCE(?,delivered_at), label_generated_at=COALESCE(label_generated_at,?)
      WHERE order_sn=?`, parameters: [latest?.description ?? null, delivered?.happenedAt ?? null,
      label?.happenedAt ?? fallbackLabel, orderSn] })
  }
  for (const item of checkpoints) {
    const key = createHash('sha1').update(`${orderSn}|logistics|${item.happenedAt}|${item.description}`).digest('hex')
    eventPositions.push(writes.length)
    writes.push({ sql: `INSERT INTO order_events
      (event_key,order_sn,source,description,happened_at,created_at,seen,raw_json)
      VALUES (?,?,'logistics',?,?,?,0,?) ON CONFLICT(event_key) DO NOTHING`,
    parameters: [key, orderSn, item.description, item.happenedAt, Date.now(), item.rawJson] })
  }
  if (audit) {
    writes.push({ sql: 'INSERT INTO tracking_audit (order_sn,checked_at) VALUES (?,?) ON CONFLICT(order_sn) DO UPDATE SET checked_at=excluded.checked_at',
      parameters: [orderSn, Date.now()] })
  }
  return { writes, eventPositions, latestStatus: latest?.description ?? null }
}

/** Um pedido ativo: uma gravação remota para status, etiqueta e checkpoints. */
export async function saveTrackingCheckpoints(orderSn: string, checkpoints: TrackingCheckpoint[]): Promise<{ newEvents: number; latestStatus: string | null }> {
  const prepared = trackingWrites(orderSn, checkpoints, null, false)
  if (!prepared.writes.length) return { newEvents: 0, latestStatus: null }
  const changes = await getAsyncDb().batch(prepared.writes)
  return { newEvents: prepared.eventPositions.reduce((count, index) => count + changes[index].changes, 0),
    latestStatus: prepared.latestStatus }
}

export async function listHistoricalTrackingCandidates(
  full: boolean, orderSns?: Set<string>
): Promise<Candidate[]> {
  if (orderSns && orderSns.size === 0) return []
  const db = getAsyncDb()
  const scoped = orderSns ? [...orderSns] : []
  return await (await db.prepare(`SELECT o.order_sn, o.shopee_order_id, o.label_generated_at
    FROM orders o LEFT JOIN tracking_audit a ON a.order_sn=o.order_sn
    WHERE o.tab='CONCLUIDO' AND o.shopee_order_id IS NOT NULL AND a.order_sn IS NULL
      ${orderSns ? `AND o.order_sn IN (${scoped.map(() => '?').join(',')})` : ''}
      AND (o.label_generated_at IS NULL OR o.delivered_at IS NULL OR NOT EXISTS (
        SELECT 1 FROM order_events e WHERE e.order_sn=o.order_sn AND e.source='logistics'
          AND (LOWER(e.description) LIKE '%postado%' OR LOWER(e.description) LIKE '%coletado%')))
    ORDER BY o.created_at_shopee DESC LIMIT ?`)).all([...scoped, full ? -1 : 25]) as Candidate[]
}

export async function listSentTrackingTargets(): Promise<TrackingTarget[]> {
  const rows = await (await getAsyncDb().prepare(`SELECT order_sn,shopee_order_id,logistics_status
    FROM orders WHERE tab='ENVIADO' AND shopee_order_id IS NOT NULL AND delivered_at IS NULL
    ORDER BY created_at_shopee DESC`)).all([]) as {
    order_sn: string; shopee_order_id: string; logistics_status: string | null
  }[]
  return rows.map((row) => ({ orderSn: row.order_sn, shopeeOrderId: row.shopee_order_id,
    logisticsStatus: row.logistics_status }))
}

/** Completa uma vez os rastreios de pedidos concluídos, em lotes de escrita no Turso. */
export async function syncHistoricalTracking(
  options: { full: boolean; orderSns?: Set<string>; onProgress: (done: number, total: number) => void; shouldCancel: () => boolean }
): Promise<{ checked: number; failed: number; newEvents: number; halted: boolean }> {
  const db = getAsyncDb()
  const rows = await listHistoricalTrackingCandidates(options.full, options.orderSns)
  const result = { checked: 0, failed: 0, newEvents: 0, halted: false }
  let consecutiveTrackingFailures = 0
  options.onProgress(0, rows.length)
  let writes: Write[] = []
  let eventPositions: number[] = []
  const flush = async (): Promise<void> => {
    if (!writes.length) return
    const changes = await db.batch(writes)
    for (const index of eventPositions) result.newEvents += changes[index].changes
    writes = []
    eventPositions = []
  }

  for (const order of rows) {
    if (options.shouldCancel()) break
    let trackingOk = false
    let labelOk = order.label_generated_at !== null
    let checkpoints: Awaited<ReturnType<typeof fetchTrackingInfo>> = []
    try {
      checkpoints = await fetchTrackingInfo(order.order_sn, order.shopee_order_id)
      trackingOk = true
    } catch { /* A falha fica no resultado e o pedido poderá ser tentado novamente. */ }
    consecutiveTrackingFailures = trackingOk ? 0 : consecutiveTrackingFailures + 1
    const labelCheckpoint = checkpoints.find((item) => item.description.trim().toLocaleLowerCase('pt-BR') === 'pedido em preparação')
    let label = labelCheckpoint?.happenedAt ?? null
    if (label) labelOk = true
    if (!labelOk && !label) {
      try {
        label = await fetchLabelGeneratedAt(order.shopee_order_id)
        labelOk = true
      } catch { /* Mantém este pedido elegível para outra tentativa. */ }
    }
    const prepared = trackingWrites(order.order_sn, checkpoints, label, trackingOk && labelOk)
    eventPositions.push(...prepared.eventPositions.map((index) => index + writes.length))
    writes.push(...prepared.writes)
    if (!trackingOk || !labelOk) result.failed++
    result.checked++
    options.onProgress(result.checked, rows.length)
    if (result.checked % BATCH_SIZE === 0) await flush()
    if (consecutiveTrackingFailures >= 3) {
      result.halted = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  await flush()
  return result
}
