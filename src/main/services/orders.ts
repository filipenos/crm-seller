import { getDb } from '../db'
import type {
  InternalStatus,
  Order,
  OrderFilters,
  OrderItem,
  StatusHistoryEntry
} from '@shared/types'
import { INTERNAL_STATUSES } from '@shared/types'

interface OrderRow {
  order_sn: string
  shopee_order_id: string | null
  shopee_status: string | null
  internal_status: string
  buyer_username: string | null
  buyer_name: string | null
  total_amount: number | null
  currency: string | null
  child_name: string | null
  note: string | null
  tracking_number: string | null
  ship_by_date: number | null
  folder_path: string | null
  label_path: string | null
  created_at_shopee: number | null
  updated_at_shopee: number | null
  synced_at: number | null
  logistics_status: string | null
  delivered_at: number | null
  rating_star: number | null
  rating_comment: string | null
  rated_at: number | null
  escrow_amount: number | null
  escrow_released_at: number | null
}

function rowToOrder(row: OrderRow, items: OrderItem[], unreadMessages: number): Order {
  return {
    orderSn: row.order_sn,
    shopeeOrderId: row.shopee_order_id,
    shopeeStatus: row.shopee_status,
    internalStatus: row.internal_status as InternalStatus,
    buyerUsername: row.buyer_username,
    buyerName: row.buyer_name,
    totalAmount: row.total_amount,
    currency: row.currency,
    childName: row.child_name,
    note: row.note,
    trackingNumber: row.tracking_number,
    shipByDate: row.ship_by_date,
    folderPath: row.folder_path,
    labelPath: row.label_path,
    createdAtShopee: row.created_at_shopee,
    updatedAtShopee: row.updated_at_shopee,
    syncedAt: row.synced_at,
    logisticsStatus: row.logistics_status,
    deliveredAt: row.delivered_at,
    ratingStar: row.rating_star,
    ratingComment: row.rating_comment,
    ratedAt: row.rated_at,
    escrowAmount: row.escrow_amount,
    escrowReleasedAt: row.escrow_released_at,
    items,
    unreadMessages
  }
}

function loadItems(orderSns: string[]): Map<string, OrderItem[]> {
  const map = new Map<string, OrderItem[]>()
  if (orderSns.length === 0) return map
  const placeholders = orderSns.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT * FROM order_items WHERE order_sn IN (${placeholders})`)
    .all(...orderSns) as {
    id: number
    order_sn: string
    item_name: string
    model_name: string | null
    quantity: number
    image_url: string | null
    item_sku: string | null
  }[]
  for (const r of rows) {
    const item: OrderItem = {
      id: r.id,
      orderSn: r.order_sn,
      itemName: r.item_name,
      modelName: r.model_name,
      quantity: r.quantity,
      imageUrl: r.image_url,
      itemSku: r.item_sku
    }
    const list = map.get(r.order_sn) ?? []
    list.push(item)
    map.set(r.order_sn, list)
  }
  return map
}

export function listOrders(filters: OrderFilters = {}): Order[] {
  const db = getDb()
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters.internalStatus && filters.internalStatus !== 'TODOS') {
    conditions.push('internal_status = ?')
    params.push(filters.internalStatus)
  }
  if (filters.search) {
    conditions.push(
      '(order_sn LIKE ? OR buyer_username LIKE ? OR buyer_name LIKE ? OR child_name LIKE ?)'
    )
    const like = `%${filters.search}%`
    params.push(like, like, like, like)
  }
  if (filters.awaitingPayment) {
    conditions.push(
      "escrow_released_at IS NULL AND delivered_at IS NOT NULL AND internal_status != 'CANCELADO'"
    )
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM orders ${where} ORDER BY created_at_shopee DESC, order_sn DESC`)
    .all(...params) as OrderRow[]

  const items = loadItems(rows.map((r) => r.order_sn))
  return rows.map((r) => rowToOrder(r, items.get(r.order_sn) ?? [], 0))
}

export function getOrder(orderSn: string): Order | null {
  const row = getDb().prepare('SELECT * FROM orders WHERE order_sn = ?').get(orderSn) as
    | OrderRow
    | undefined
  if (!row) return null
  const items = loadItems([orderSn])
  return rowToOrder(row, items.get(orderSn) ?? [], 0)
}

export function setInternalStatus(orderSn: string, status: InternalStatus): Order | null {
  if (!INTERNAL_STATUSES.includes(status)) {
    throw new Error(`Status interno inválido: ${status}`)
  }
  const db = getDb()
  const current = db
    .prepare('SELECT internal_status FROM orders WHERE order_sn = ?')
    .get(orderSn) as { internal_status: string } | undefined
  if (!current) return null
  if (current.internal_status !== status) {
    const tx = db.transaction(() => {
      db.prepare('UPDATE orders SET internal_status = ? WHERE order_sn = ?').run(status, orderSn)
      db.prepare(
        'INSERT INTO status_history (order_sn, from_status, to_status, changed_at) VALUES (?, ?, ?, ?)'
      ).run(orderSn, current.internal_status, status, Date.now())
    })
    tx()
  }
  return getOrder(orderSn)
}

export function setChildName(orderSn: string, childName: string): Order | null {
  getDb()
    .prepare('UPDATE orders SET child_name = ? WHERE order_sn = ?')
    .run(childName.trim() || null, orderSn)
  return getOrder(orderSn)
}

export function setNote(orderSn: string, note: string): Order | null {
  getDb()
    .prepare('UPDATE orders SET note = ? WHERE order_sn = ?')
    .run(note.trim() || null, orderSn)
  return getOrder(orderSn)
}

export function setFolderPath(orderSn: string, folderPath: string): void {
  getDb().prepare('UPDATE orders SET folder_path = ? WHERE order_sn = ?').run(folderPath, orderSn)
}

export function setLabelPath(orderSn: string, labelPath: string): void {
  getDb().prepare('UPDATE orders SET label_path = ? WHERE order_sn = ?').run(labelPath, orderSn)
}

export function setLogisticsStatus(
  orderSn: string,
  status: string,
  deliveredAt: number | null
): void {
  getDb()
    .prepare(
      'UPDATE orders SET logistics_status = ?, delivered_at = COALESCE(?, delivered_at) WHERE order_sn = ?'
    )
    .run(status, deliveredAt, orderSn)
}

export function setRating(
  orderSn: string,
  star: number,
  comment: string | null,
  ratedAt: number | null
): void {
  getDb()
    .prepare(
      'UPDATE orders SET rating_star = ?, rating_comment = ?, rated_at = COALESCE(?, rated_at) WHERE order_sn = ?'
    )
    .run(star, comment, ratedAt, orderSn)
}

export function setEscrow(orderSn: string, amount: number | null, releasedAt: number): void {
  getDb()
    .prepare(
      'UPDATE orders SET escrow_amount = COALESCE(?, escrow_amount), escrow_released_at = ? WHERE order_sn = ?'
    )
    .run(amount, releasedAt, orderSn)
}

/** Pedidos entregues cujo pagamento ainda não caiu — a lista de cobrança a vigiar. */
export function countAwaitingPayment(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
       WHERE escrow_released_at IS NULL
         AND delivered_at IS NOT NULL
         AND internal_status != 'CANCELADO'`
    )
    .get() as { n: number }
  return row.n
}

export function getStatusHistory(orderSn: string): StatusHistoryEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM status_history WHERE order_sn = ? ORDER BY changed_at DESC')
    .all(orderSn) as {
    id: number
    order_sn: string
    from_status: string | null
    to_status: string
    changed_at: number
  }[]
  return rows.map((r) => ({
    id: r.id,
    orderSn: r.order_sn,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    changedAt: r.changed_at
  }))
}

export interface UpsertOrderInput {
  orderSn: string
  shopeeOrderId?: string | null
  shopeeStatus?: string | null
  buyerUsername?: string | null
  buyerName?: string | null
  totalAmount?: number | null
  currency?: string | null
  trackingNumber?: string | null
  shipByDate?: number | null
  createdAtShopee?: number | null
  updatedAtShopee?: number | null
  rawJson?: string
  items?: {
    itemName: string
    modelName: string | null
    quantity: number
    imageUrl: string | null
    itemSku: string | null
  }[]
}

/** Insere/atualiza um pedido vindo da Shopee. Retorna true se o pedido é novo. */
export function upsertShopeeOrder(input: UpsertOrderInput): boolean {
  const db = getDb()
  const existing = db
    .prepare('SELECT order_sn, internal_status FROM orders WHERE order_sn = ?')
    .get(input.orderSn) as { order_sn: string; internal_status: string } | undefined

  const now = Date.now()
  const tx = db.transaction(() => {
    if (!existing) {
      db.prepare(
        `INSERT INTO orders (
          order_sn, shopee_order_id, shopee_status, internal_status, buyer_username, buyer_name,
          total_amount, currency, tracking_number, ship_by_date,
          created_at_shopee, updated_at_shopee, synced_at, raw_json
        ) VALUES (?, ?, ?, 'NOVO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.orderSn,
        input.shopeeOrderId ?? null,
        input.shopeeStatus ?? null,
        input.buyerUsername ?? null,
        input.buyerName ?? null,
        input.totalAmount ?? null,
        input.currency ?? null,
        input.trackingNumber ?? null,
        input.shipByDate ?? null,
        input.createdAtShopee ?? null,
        input.updatedAtShopee ?? null,
        now,
        input.rawJson ?? null
      )
      db.prepare(
        'INSERT INTO status_history (order_sn, from_status, to_status, changed_at) VALUES (?, NULL, ?, ?)'
      ).run(input.orderSn, 'NOVO', now)
    } else {
      db.prepare(
        `UPDATE orders SET
          shopee_order_id = COALESCE(?, shopee_order_id),
          shopee_status = COALESCE(?, shopee_status),
          buyer_username = COALESCE(?, buyer_username),
          buyer_name = COALESCE(?, buyer_name),
          total_amount = COALESCE(?, total_amount),
          currency = COALESCE(?, currency),
          tracking_number = COALESCE(?, tracking_number),
          ship_by_date = COALESCE(?, ship_by_date),
          created_at_shopee = COALESCE(?, created_at_shopee),
          updated_at_shopee = COALESCE(?, updated_at_shopee),
          synced_at = ?,
          raw_json = COALESCE(?, raw_json)
        WHERE order_sn = ?`
      ).run(
        input.shopeeOrderId ?? null,
        input.shopeeStatus ?? null,
        input.buyerUsername ?? null,
        input.buyerName ?? null,
        input.totalAmount ?? null,
        input.currency ?? null,
        input.trackingNumber ?? null,
        input.shipByDate ?? null,
        input.createdAtShopee ?? null,
        input.updatedAtShopee ?? null,
        now,
        input.rawJson ?? null,
        input.orderSn
      )
    }

    if (input.items && input.items.length > 0) {
      db.prepare('DELETE FROM order_items WHERE order_sn = ?').run(input.orderSn)
      const insertItem = db.prepare(
        `INSERT INTO order_items (order_sn, item_name, model_name, quantity, image_url, item_sku)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (const item of input.items) {
        insertItem.run(
          input.orderSn,
          item.itemName,
          item.modelName,
          item.quantity,
          item.imageUrl,
          item.itemSku
        )
      }
    }
  })
  tx()
  return !existing
}
