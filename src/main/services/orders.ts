import { getDb } from '../db'
import type {
  InternalStatus,
  Order,
  OrderFilters,
  OrderItem,
  OrderTab,
  OrderCounts,
  Recebimento,
  TabCounts,
  StatusHistoryEntry
} from '@shared/types'
import { INTERNAL_STATUSES, ORDER_TABS } from '@shared/types'
import { deriveTab, isReadyToPost } from './tabs'
import { contarSemExtrato, getRecebimento, rowToRecebimento } from './recebimentos'

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
  tab: string | null
  ready_to_post: number
  status_description: string | null
  payment_method: string | null
  carrier: string | null
  shipping_city: string | null
  shopee_url_path: string | null
  package_number: string | null
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

function rowToOrder(row: OrderRow, items: OrderItem[], recebimento: Recebimento | null = null): Order {
  return {
    orderSn: row.order_sn,
    shopeeOrderId: row.shopee_order_id,
    shopeeStatus: row.shopee_status,
    // Vem da coluna, calculada na entrada. O fallback cobre linhas gravadas
    // antes da migração 9 e some no primeiro reprocessamento.
    tab:
      (row.tab as OrderTab | null) ??
      deriveTab({ shopeeStatus: row.shopee_status, escrowReleasedAt: row.escrow_released_at }),
    readyToPost: row.ready_to_post === 1,
    statusDescription: row.status_description,
    paymentMethod: row.payment_method,
    carrier: row.carrier,
    shippingCity: row.shipping_city,
    shopeeUrlPath: row.shopee_url_path,
    packageNumber: row.package_number,
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
    recebimento,
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

/**
 * Recalcula os campos que são **nossos** a partir do que a Shopee mandou.
 *
 * Chamado sempre que muda algo que os afeta: o card (sincronização) ou o
 * pagamento (extrato). Concentrar aqui é o que evita a regra existir em dois
 * lugares — antes ela estava em `tabs.ts` e repetida em SQL.
 */
export function recomputeDerived(orderSn: string): void {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT shopee_status, escrow_released_at, logistics_code FROM orders WHERE order_sn = ?'
    )
    .get(orderSn) as
    | { shopee_status: string | null; escrow_released_at: number | null; logistics_code: number | null }
    | undefined
  if (!row) return

  const tab = deriveTab({
    shopeeStatus: row.shopee_status,
    escrowReleasedAt: row.escrow_released_at
  })
  db.prepare('UPDATE orders SET tab = ?, ready_to_post = ? WHERE order_sn = ?').run(
    tab,
    isReadyToPost(row.logistics_code) ? 1 : 0,
    orderSn
  )
}

/**
 * Campos pesquisáveis, e o prefixo que restringe a busca a cada um.
 *
 * "tema" e "produto" apontam para o mesmo lugar de propósito: a Shopee não tem
 * campo de tema — ele está dentro do nome do anúncio ("…Guerreiras do K-Pop…"),
 * junto com a variação.
 */
const CAMPOS_BUSCA: Record<string, string[]> = {
  id: ['o.order_sn'],
  url: ['o.shopee_order_id'],
  rastreio: ['o.tracking_number', 'o.package_number'],
  nick: ['o.buyer_username'],
  nome: ['o.buyer_name', 'o.child_name'],
  produto: ['ITEM'],
  tema: ['ITEM']
}

/** Todos os campos, para a busca livre (sem prefixo). */
const BUSCA_LIVRE = [
  'o.order_sn',
  'o.shopee_order_id',
  'o.tracking_number',
  'o.package_number',
  'o.buyer_username',
  'o.buyer_name',
  'o.child_name',
  'ITEM'
]

/**
 * Compara ignorando hífen, espaço e ponto.
 *
 * O anúncio escreve "K-Pop" e a pessoa digita "kpop"; sem isso a busca por tema
 * — que é o uso principal — não acha nada. (Acentos ficam de fora: o SQLite não
 * remove acento sem extensão, e "boneca"/"bonecas" já resolve com LIKE parcial.)
 */
function semPontuacao(expr: string): string {
  return `REPLACE(REPLACE(REPLACE(LOWER(COALESCE(${expr}, '')), '-', ''), ' ', ''), '.', '')`
}

function normaliza(texto: string): string {
  return texto.toLowerCase().replace(/[-\s.]/g, '')
}

/** Busca dentro dos itens do pedido (nome do produto e variação). */
const ITEM_SQL = `EXISTS (
  SELECT 1 FROM order_items it
   WHERE it.order_sn = o.order_sn
     AND (${semPontuacao('it.item_name')} LIKE ? OR ${semPontuacao('it.model_name')} LIKE ?)
)`

/**
 * Monta a busca. Tudo é LIKE parcial — o código do QR às vezes vem concatenado
 * com outro, e ninguém digita o nome do produto inteiro. `prefixo:valor`
 * restringe a um campo; sem prefixo, procura em todos.
 */
function montaBusca(termo: string): { sql: string; params: unknown[] } {
  const texto = termo.trim()
  if (!texto) return { sql: '', params: [] }

  const comPrefixo = /^([a-zA-Z]+):(.*)$/.exec(texto)
  const campos =
    comPrefixo && CAMPOS_BUSCA[comPrefixo[1].toLowerCase()]
      ? CAMPOS_BUSCA[comPrefixo[1].toLowerCase()]
      : BUSCA_LIVRE
  const valor = comPrefixo && CAMPOS_BUSCA[comPrefixo[1].toLowerCase()] ? comPrefixo[2] : texto
  const like = `%${normaliza(valor.trim())}%`

  const partes: string[] = []
  const params: unknown[] = []
  for (const campo of campos) {
    if (campo === 'ITEM') {
      partes.push(ITEM_SQL)
      params.push(like, like)
    } else {
      partes.push(`${semPontuacao(campo)} LIKE ?`)
      params.push(like)
    }
  }
  return { sql: `(${partes.join(' OR ')})`, params }
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
    const { sql, params: buscaParams } = montaBusca(filters.search)
    if (sql) {
      conditions.push(sql)
      params.push(...buscaParams)
    }
  }
  if (filters.awaitingPayment) {
    conditions.push(`(${AWAITING_PAYMENT_WHERE})`)
  }
  if (filters.readyToPost) {
    conditions.push('o.ready_to_post = 1')
  }
  if (filters.tab && filters.tab !== 'TODOS') {
    conditions.push('o.tab = ?')
    params.push(filters.tab)
  } else {
    // Sem aba escolhida, cancelados não entram na listagem: são a última aba.
    conditions.push("o.tab != 'CANCELADO'")
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

  const sns = rows.map((r) => r.order_sn)
  const items = loadItems(sns)
  const extratos = loadRecebimentos(sns)
  return rows.map((r) => rowToOrder(r, items.get(r.order_sn) ?? [], extratos.get(r.order_sn) ?? null))
}

/** Extratos de vários pedidos numa consulta só, para a listagem não fazer N+1. */
function loadRecebimentos(orderSns: string[]): Map<string, Recebimento> {
  const map = new Map<string, Recebimento>()
  if (orderSns.length === 0) return map
  const placeholders = orderSns.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT * FROM order_income WHERE order_sn IN (${placeholders})`)
    .all(...orderSns) as Parameters<typeof rowToRecebimento>[0][]
  for (const row of rows) map.set(row.order_sn, rowToRecebimento(row))
  return map
}

/**
 * Total de pedidos por fase, sempre sobre a base inteira.
 *
 * Contar em cima da lista já filtrada daria o número da tela, não o total —
 * e o objetivo das abas é justamente saber quantos existem em cada fase antes
 * de clicar.
 */
export function countByTab(): OrderCounts {
  const tabs = Object.fromEntries(ORDER_TABS.map((t) => [t, 0])) as TabCounts
  const rows = getDb()
    .prepare('SELECT tab, COUNT(*) AS n FROM orders WHERE tab IS NOT NULL GROUP BY tab')
    .all() as { tab: OrderTab; n: number }[]
  for (const row of rows) if (row.tab in tabs) tabs[row.tab] = row.n

  const ready = getDb()
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE ready_to_post = 1 AND tab = 'A_ENVIAR'")
    .get() as { n: number }
  return { tabs, readyToPost: ready.n, semExtrato: contarSemExtrato('CONCLUIDO') }
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
  return rowToOrder(row, items.get(orderSn) ?? [], getRecebimento(orderSn))
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
 * Guarda o valor e a liberação do pedido. `releasedAt` nulo é normal: a Shopee
 * calcula o valor antes de soltar o dinheiro — é o estado "aguardando
 * pagamento". Só entra aqui data que **já passou**; previsão fica no extrato.
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
  // O pagamento muda a aba: o mesmo pedido sai de Enviado para Concluído.
  recomputeDerived(orderSn)
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
/**
 * Enviado e ainda sem pagamento liberado. Fala a nossa língua: a aba já foi
 * decidida na entrada, então aqui não há texto da Shopee nenhum.
 */
const AWAITING_PAYMENT_WHERE = `tab = 'ENVIADO' AND escrow_released_at IS NULL`

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
  const sns = rows.map((r) => r.order_sn)
  const items = loadItems(sns)
  const extratos = loadRecebimentos(sns)
  return rows.map((r) => rowToOrder(r, items.get(r.order_sn) ?? [], extratos.get(r.order_sn) ?? null))
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
  statusDescription?: string | null
  paymentMethod?: string | null
  carrier?: string | null
  shippingCity?: string | null
  shopeeUrlPath?: string | null
  packageNumber?: string | null
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
          status_description, payment_method, carrier, shipping_city, shopee_url_path,
          package_number, created_at_shopee, updated_at_shopee, synced_at, raw_json
        ) VALUES (?, ?, ?, 'NOVO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        input.statusDescription ?? null,
        input.paymentMethod ?? null,
        input.carrier ?? null,
        input.shippingCity ?? null,
        input.shopeeUrlPath ?? null,
        input.packageNumber ?? null,
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
          status_description = COALESCE(?, status_description),
          payment_method = COALESCE(?, payment_method),
          carrier = COALESCE(?, carrier),
          shipping_city = COALESCE(?, shipping_city),
          shopee_url_path = COALESCE(?, shopee_url_path),
          package_number = COALESCE(?, package_number),
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
        input.statusDescription ?? null,
        input.paymentMethod ?? null,
        input.carrier ?? null,
        input.shippingCity ?? null,
        input.shopeeUrlPath ?? null,
        input.packageNumber ?? null,
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
  // O card acabou de mudar: aba e "pronto para postar" saem daqui, não da leitura.
  recomputeDerived(input.orderSn)
  return !existing
}
