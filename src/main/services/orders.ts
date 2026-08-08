import { getDb } from '../db'
import type {
  InternalStatus,
  Order,
  OrderFilters,
  OrderItem,
  OrderTab,
  TabCounts,
  StatusHistoryEntry
} from '@shared/types'
import { INTERNAL_STATUSES, LOGISTICS_READY_TO_POST, ORDER_TABS } from '@shared/types'
import { deriveTab } from './tabs'

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
  created_at_shopee: number | null
  updated_at_shopee: number | null
  synced_at: number | null
  logistics_status: string | null
  logistics_code: number | null
  logistics_phase: string | null
  stage_id: number | null
  stage_name: string | null
  stage_color: string | null
  delivered_at: number | null
  rating_star: number | null
  rating_comment: string | null
  rated_at: number | null
  escrow_amount: number | null
  escrow_released_at: number | null
}

function rowToOrder(row: OrderRow, items: OrderItem[]): Order {
  return {
    orderSn: row.order_sn,
    shopeeOrderId: row.shopee_order_id,
    shopeeStatus: row.shopee_status,
    tab: deriveTab({
      shopeeStatus: row.shopee_status,
      escrowReleasedAt: row.escrow_released_at
    }),
    logisticsCode: row.logistics_code,
    stageId: row.stage_id,
    stageName: row.stage_name,
    stageColor: row.stage_color,
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
    items
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
  if (filters.stageId !== undefined) {
    conditions.push('o.stage_id = ?')
    params.push(filters.stageId)
  }
  if (filters.search) {
    conditions.push(
      '(order_sn LIKE ? OR buyer_username LIKE ? OR buyer_name LIKE ? OR child_name LIKE ?)'
    )
    const like = `%${filters.search}%`
    params.push(like, like, like, like)
  }
  if (filters.awaitingPayment) {
    conditions.push(`(${AWAITING_PAYMENT_WHERE})`)
  }
  if (filters.readyToPost) {
    conditions.push('o.logistics_code = ?')
    params.push(LOGISTICS_READY_TO_POST)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT o.*, s.name AS stage_name, s.color AS stage_color
         FROM orders o
         LEFT JOIN workflow_stages s ON s.id = o.stage_id
         ${where}
        ORDER BY o.created_at_shopee DESC, o.order_sn DESC`
    )
    .all(...params) as OrderRow[]

  const items = loadItems(rows.map((r) => r.order_sn))
  const orders = rows.map((r) => rowToOrder(r, items.get(r.order_sn) ?? []))
  // Fase é derivada em JS (depende de rastreio + pagamento), então o filtro
  // por fase acontece aqui e não no SQL.
  // A aba depende do pagamento, que é derivado em JS — por isso o corte é aqui.
  if (filters.tab && filters.tab !== 'TODOS') {
    return orders.filter((o) => o.tab === filters.tab)
  }
  // Sem aba escolhida, cancelados não poluem a listagem: têm página própria.
  return orders.filter((o) => o.tab !== 'CANCELADO')
}

/**
 * Total de pedidos por fase, sempre sobre a base inteira.
 *
 * Contar em cima da lista já filtrada daria o número da tela, não o total —
 * e o objetivo das abas é justamente saber quantos existem em cada fase antes
 * de clicar.
 */
export function countByTab(): TabCounts {
  const counts = Object.fromEntries(ORDER_TABS.map((t) => [t, 0])) as TabCounts
  const rows = getDb().prepare('SELECT shopee_status, escrow_released_at FROM orders').all() as {
    shopee_status: string | null
    escrow_released_at: number | null
  }[]
  for (const row of rows) {
    counts[deriveTab({ shopeeStatus: row.shopee_status, escrowReleasedAt: row.escrow_released_at })]++
  }
  return counts
}

export function getOrder(orderSn: string): Order | null {
  const row = getDb()
    .prepare(
      `SELECT o.*, s.name AS stage_name, s.color AS stage_color
         FROM orders o
         LEFT JOIN workflow_stages s ON s.id = o.stage_id
        WHERE o.order_sn = ?`
    )
    .get(orderSn) as OrderRow | undefined
  if (!row) return null
  const items = loadItems([orderSn])
  return rowToOrder(row, items.get(orderSn) ?? [])
}

/**
 * Move o pedido de etapa de produção. O histórico guarda o **nome** da etapa,
 * não o id: renomear ou apagar a etapa depois não pode reescrever o passado.
 */
export function setOrderStage(orderSn: string, stageId: number): Order | null {
  const db = getDb()
  const current = db
    .prepare(
      `SELECT o.stage_id, s.name AS stage_name
         FROM orders o LEFT JOIN workflow_stages s ON s.id = o.stage_id
        WHERE o.order_sn = ?`
    )
    .get(orderSn) as { stage_id: number | null; stage_name: string | null } | undefined
  if (!current) return null

  const target = db.prepare('SELECT name FROM workflow_stages WHERE id = ?').get(stageId) as
    | { name: string }
    | undefined
  if (!target) throw new Error(`Etapa ${stageId} não existe`)

  if (current.stage_id !== stageId) {
    const tx = db.transaction(() => {
      db.prepare('UPDATE orders SET stage_id = ? WHERE order_sn = ?').run(stageId, orderSn)
      db.prepare(
        'INSERT INTO status_history (order_sn, from_status, to_status, changed_at) VALUES (?, ?, ?, ?)'
      ).run(orderSn, current.stage_name, target.name, Date.now())
    })
    tx()
  }
  return getOrder(orderSn)
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

/** Guarda o último checkpoint do rastreio, que é detalhe do pedido. */
export function setLogisticsStatus(
  orderSn: string,
  status: string,
  deliveredAt: number | null
): void {
  getDb()
    .prepare(
      `UPDATE orders
          SET logistics_status = ?,
              delivered_at = COALESCE(?, delivered_at)
        WHERE order_sn = ?`
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

/**
 * Guarda o extrato do pedido. `releasedAt` nulo é normal: significa que a
 * Shopee já calculou o valor mas ainda não liberou o dinheiro — é exatamente
 * o estado "aguardando pagamento". COALESCE evita que uma consulta posterior
 * apague uma liberação já registrada.
 */
export function setEscrow(
  orderSn: string,
  amount: number | null,
  releasedAt: number | null
): void {
  getDb()
    .prepare(
      `UPDATE orders
          SET escrow_amount = COALESCE(?, escrow_amount),
              escrow_released_at = COALESCE(?, escrow_released_at)
        WHERE order_sn = ?`
    )
    .run(amount, releasedAt, orderSn)
}

/** Pedidos entregues cujo pagamento ainda não caiu — a lista de cobrança a vigiar. */
/**
 * Entregue mas sem pagamento liberado.
 *
 * A entrega é reconhecida pela fase do rastreio **ou** pelo status do card —
 * exigir `delivered_at` deixaria de fora todo pedido cujo rastreio ninguém
 * pediu, que é a maioria.
 */
/**
 * Entregue/enviado e ainda sem pagamento liberado — os pedidos cuja aba só
 * fica certa depois de consultar o extrato. São poucos (na conta real, 28),
 * o que torna viável consultá-los todos.
 */
const AWAITING_PAYMENT_WHERE = `
  escrow_released_at IS NULL
  AND COALESCE(shopee_status, '') NOT LIKE '%ancelad%'
  AND COALESCE(shopee_status, '') NOT LIKE '%onclu%'
  AND COALESCE(shopee_status, '') NOT LIKE '%A Enviar%'
`

export function countAwaitingPayment(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${AWAITING_PAYMENT_WHERE}`)
    .get() as { n: number }
  return row.n
}

/** Os mais antigos primeiro: são os que já deveriam ter sido pagos. */
export function listAwaitingPayment(limit: number): Order[] {
  const rows = getDb()
    .prepare(
      `SELECT o.*, s.name AS stage_name, s.color AS stage_color
         FROM orders o
         LEFT JOIN workflow_stages s ON s.id = o.stage_id
        WHERE ${AWAITING_PAYMENT_WHERE}
          AND o.shopee_order_id IS NOT NULL
        ORDER BY o.created_at_shopee ASC
        LIMIT ?`
    )
    .all(limit) as OrderRow[]
  const items = loadItems(rows.map((r) => r.order_sn))
  return rows.map((r) => rowToOrder(r, items.get(r.order_sn) ?? []))
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
  /** 1 etiquetado · 9 aguardando · 2 enviado (order_ext_info.logistics_status). */
  logisticsCode?: number | null
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
          total_amount, currency, tracking_number, ship_by_date, logistics_code,
          created_at_shopee, updated_at_shopee, synced_at, raw_json
        ) VALUES (?, ?, ?, 'NOVO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        input.logisticsCode ?? null,
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
          logistics_code = COALESCE(?, logistics_code),
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
        input.logisticsCode ?? null,
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
