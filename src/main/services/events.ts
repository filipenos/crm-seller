import { createHash } from 'crypto'
import { getDb } from '../db'
import type { OrderEvent, OrderEventSource } from '@shared/types'

interface EventRow {
  event_key: string
  order_sn: string
  source: OrderEventSource
  description: string
  happened_at: number
  created_at: number
  seen: number
}

function rowToEvent(r: EventRow): OrderEvent {
  return {
    eventKey: r.event_key,
    orderSn: r.order_sn,
    source: r.source,
    description: r.description,
    happenedAt: r.happened_at,
    createdAt: r.created_at,
    seen: r.seen === 1
  }
}

export interface RecordEventInput {
  orderSn: string
  source: OrderEventSource
  description: string
  happenedAt: number
  rawJson?: string
}

/** Registra um evento (idempotente). Retorna true se é novo. */
export function recordEvent(input: RecordEventInput): boolean {
  const eventKey = createHash('sha1')
    .update(`${input.orderSn}|${input.source}|${input.happenedAt}|${input.description}`)
    .digest('hex')
  const result = getDb()
    .prepare(
      `INSERT INTO order_events (event_key, order_sn, source, description, happened_at, created_at, seen, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(event_key) DO NOTHING`
    )
    .run(
      eventKey,
      input.orderSn,
      input.source,
      input.description,
      input.happenedAt,
      Date.now(),
      input.rawJson ?? null
    )
  return result.changes > 0
}

export function listEvents(opts: { onlyUnseen?: boolean; limit?: number } = {}): OrderEvent[] {
  const where = opts.onlyUnseen ? 'WHERE seen = 0' : ''
  const rows = getDb()
    .prepare(`SELECT * FROM order_events ${where} ORDER BY happened_at DESC LIMIT ?`)
    .all(opts.limit ?? 200) as EventRow[]
  return rows.map(rowToEvent)
}

export function listEventsForOrder(orderSn: string): OrderEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM order_events WHERE order_sn = ? ORDER BY happened_at ASC')
    .all(orderSn) as EventRow[]
  return rows.map(rowToEvent)
}

export function countUnseenEvents(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM order_events WHERE seen = 0').get() as {
    n: number
  }
  return row.n
}

export function markAllEventsSeen(): void {
  getDb().prepare('UPDATE order_events SET seen = 1 WHERE seen = 0').run()
}
