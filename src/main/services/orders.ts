import { getAsyncDb } from '../db'
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
import { rowToRecebimento } from './recebimentos'

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

// `raw_json` pode ser muito maior que todos os demais campos juntos e não é
// usado nas telas. Nunca o transfira do Turso para uma listagem ou detalhe.
const ORDER_VIEW_COLUMNS = `
  o.order_sn, o.shopee_order_id, o.shopee_status, o.internal_status,
  o.buyer_username, o.buyer_name, o.total_amount, o.currency, o.child_name,
  o.note, o.tracking_number, o.ship_by_date, o.folder_path, o.created_at_shopee,
  o.updated_at_shopee, o.synced_at, o.logistics_status, o.logistics_code, o.tab,
  o.ready_to_post, o.status_description, o.payment_method, o.carrier,
  o.shipping_city, o.shopee_url_path, o.package_number, o.logistics_phase,
  o.stage_id, o.delivered_at, o.rating_star, o.rating_comment, o.rated_at,
  o.escrow_amount, o.escrow_released_at,
  s.name AS stage_name, s.color AS stage_color`

const INCOME_VIEW_COLUMNS = `
  order_sn, valor_produtos, valor_frete, desconto_cupons, taxa_comissao,
  taxa_servico, outras_taxas, valor_recebido, recebido_em, previsto_para`

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

async function loadItemsAsync(orderSns: string[]): Promise<Map<string, OrderItem[]>> {
  const map = new Map<string, OrderItem[]>()
  if (orderSns.length === 0) return map
  const statement = await getAsyncDb().prepare(
    `SELECT * FROM order_items WHERE order_sn IN (${orderSns.map(() => '?').join(',')})`
  )
  const rows = (await statement.all(orderSns)) as {
    id: number; order_sn: string; item_name: string; model_name: string | null
    quantity: number; image_url: string | null; item_sku: string | null; pecas: number | null
  }[]
  for (const r of rows) {
    const list = map.get(r.order_sn) ?? []
    list.push({
      id: r.id, orderSn: r.order_sn, itemName: r.item_name, modelName: r.model_name,
      quantity: r.quantity, imageUrl: r.image_url, itemSku: r.item_sku, pecas: r.pecas
    })
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
export async function recomputeDerivedAsync(orderSn: string): Promise<void> {
  const db = getAsyncDb()
  const select = await db.prepare(
    'SELECT shopee_status, escrow_released_at, logistics_code FROM orders WHERE order_sn = ?'
  )
  const row = (await select.get([orderSn])) as
    | { shopee_status: string | null; escrow_released_at: number | null; logistics_code: number | null }
    | undefined
  if (!row) return
  const update = await db.prepare('UPDATE orders SET tab = ?, ready_to_post = ? WHERE order_sn = ?')
  await update.run([
    deriveTab({ shopeeStatus: row.shopee_status, escrowReleasedAt: row.escrow_released_at }),
    isReadyToPost(row.logistics_code) ? 1 : 0,
    orderSn
  ])
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

/** Leitura não bloqueante da listagem principal. */
export async function listOrdersAsync(filters: OrderFilters = {}): Promise<Order[]> {
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
    const busca = montaBusca(filters.search)
    if (busca.sql) {
      conditions.push(busca.sql)
      params.push(...busca.params)
    }
  }
  if (filters.awaitingPayment) conditions.push(`(${AWAITING_PAYMENT_WHERE})`)
  if (filters.readyToPost) conditions.push('o.ready_to_post = 1')
  if (filters.tab && filters.tab !== 'TODOS') {
    conditions.push('o.tab = ?')
    params.push(filters.tab)
  } else {
    conditions.push("o.tab != 'CANCELADO'")
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = filters.limit === undefined ? null : Math.min(5000, Math.max(1, filters.limit))
  const limitSql = limit === null ? '' : 'LIMIT ?'
  if (limit !== null) params.push(limit)
  const statement = await getAsyncDb().prepare(
    `SELECT ${ORDER_VIEW_COLUMNS}
       FROM orders o LEFT JOIN workflow_stages s ON s.id = o.stage_id
       ${where}
      ORDER BY o.created_at_shopee DESC, o.order_sn DESC
      ${limitSql}`
  )
  const rows = (await statement.all(params)) as OrderRow[]
  const sns = rows.map((r) => r.order_sn)
  const [items, extratos] = await Promise.all([
    loadItemsAsync(sns),
    loadRecebimentosAsync(sns)
  ])
  return rows.map((r) => rowToOrder(r, items.get(r.order_sn) ?? [], extratos.get(r.order_sn) ?? null))
}

/** Extratos de vários pedidos numa consulta só, para a listagem não fazer N+1. */
async function loadRecebimentosAsync(orderSns: string[]): Promise<Map<string, Recebimento>> {
  const map = new Map<string, Recebimento>()
  if (orderSns.length === 0) return map
  const statement = await getAsyncDb().prepare(
    `SELECT ${INCOME_VIEW_COLUMNS} FROM order_income WHERE order_sn IN (${orderSns.map(() => '?').join(',')})`
  )
  const rows = (await statement.all(orderSns)) as Parameters<typeof rowToRecebimento>[0][]
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
export async function countByTabAsync(): Promise<OrderCounts> {
  const db = getAsyncDb()
  const [tabsStatement, readyStatement, incomeStatement] = await Promise.all([
    db.prepare('SELECT tab, COUNT(*) AS n FROM orders WHERE tab IS NOT NULL GROUP BY tab'),
    db.prepare("SELECT COUNT(*) AS n FROM orders WHERE ready_to_post = 1 AND tab = 'A_ENVIAR'"),
    db.prepare(`SELECT COUNT(*) AS n FROM orders o LEFT JOIN order_income i ON i.order_sn = o.order_sn
      WHERE o.tab = 'CONCLUIDO' AND o.shopee_order_id IS NOT NULL AND i.order_sn IS NULL`)
  ])
  const [rows, ready, semExtrato] = await Promise.all([
    tabsStatement.all([]) as Promise<{ tab: OrderTab; n: number }[]>,
    readyStatement.get([]) as Promise<{ n: number }>,
    incomeStatement.get([]) as Promise<{ n: number }>
  ])
  const tabs = Object.fromEntries(ORDER_TABS.map((t) => [t, 0])) as TabCounts
  for (const row of rows) if (row.tab in tabs) tabs[row.tab] = row.n
  return { tabs, readyToPost: ready.n, semExtrato: semExtrato.n }
}

export async function getOrderAsync(orderSn: string): Promise<Order | null> {
  const db = getAsyncDb()
  const orderStatement = await db.prepare(
    `SELECT ${ORDER_VIEW_COLUMNS}
       FROM orders o LEFT JOIN workflow_stages s ON s.id = o.stage_id
      WHERE o.order_sn = ?`
  )
  const row = (await orderStatement.get([orderSn])) as OrderRow | undefined
  if (!row) return null
  const incomeStatement = await db.prepare(
    `SELECT ${INCOME_VIEW_COLUMNS} FROM order_income WHERE order_sn = ?`
  )
  const [items, incomeRow] = await Promise.all([
    loadItemsAsync([orderSn]),
    incomeStatement.get([orderSn]) as Promise<Parameters<typeof rowToRecebimento>[0] | undefined>
  ])
  return rowToOrder(row, items.get(orderSn) ?? [], incomeRow ? rowToRecebimento(incomeRow) : null)
}

/**
 * Move o pedido de etapa de produção. O histórico guarda o **nome** da etapa,
 * não o id: renomear ou apagar a etapa depois não pode reescrever o passado.
 */
export async function setOrderStageAsync(orderSn: string, stageId: number): Promise<Order | null> {
  const db = getAsyncDb()
  const currentStatement = await db.prepare(
    `SELECT o.stage_id, s.name AS stage_name FROM orders o
      LEFT JOIN workflow_stages s ON s.id = o.stage_id WHERE o.order_sn = ?`
  )
  const targetStatement = await db.prepare('SELECT name FROM workflow_stages WHERE id = ?')
  const [current, target] = await Promise.all([
    currentStatement.get([orderSn]) as Promise<{ stage_id: number | null; stage_name: string | null } | undefined>,
    targetStatement.get([stageId]) as Promise<{ name: string } | undefined>
  ])
  if (!current) return null
  if (!target) throw new Error(`Etapa ${stageId} não existe`)
  if (current.stage_id !== stageId) {
    const update = await db.prepare('UPDATE orders SET stage_id = ? WHERE order_sn = ?')
    const history = await db.prepare(
      'INSERT INTO status_history (order_sn, from_status, to_status, changed_at) VALUES (?, ?, ?, ?)'
    )
    await update.run([stageId, orderSn])
    await history.run([orderSn, current.stage_name, target.name, Date.now()])
  }
  return getOrderAsync(orderSn)
}

export async function setInternalStatusAsync(
  orderSn: string,
  status: InternalStatus
): Promise<Order | null> {
  if (!INTERNAL_STATUSES.includes(status)) throw new Error(`Status interno inválido: ${status}`)
  const db = getAsyncDb()
  const select = await db.prepare('SELECT internal_status FROM orders WHERE order_sn = ?')
  const current = (await select.get([orderSn])) as { internal_status: string } | undefined
  if (!current) return null
  if (current.internal_status !== status) {
    const update = await db.prepare('UPDATE orders SET internal_status = ? WHERE order_sn = ?')
    const history = await db.prepare(
      'INSERT INTO status_history (order_sn, from_status, to_status, changed_at) VALUES (?, ?, ?, ?)'
    )
    await update.run([status, orderSn])
    await history.run([orderSn, current.internal_status, status, Date.now()])
  }
  return getOrderAsync(orderSn)
}

export async function setChildNameAsync(orderSn: string, childName: string): Promise<Order | null> {
  const statement = await getAsyncDb().prepare('UPDATE orders SET child_name = ? WHERE order_sn = ?')
  await statement.run([childName.trim() || null, orderSn])
  return getOrderAsync(orderSn)
}

export async function setNoteAsync(orderSn: string, note: string): Promise<Order | null> {
  const statement = await getAsyncDb().prepare('UPDATE orders SET note = ? WHERE order_sn = ?')
  await statement.run([note.trim() || null, orderSn])
  return getOrderAsync(orderSn)
}

export async function setFolderPathAsync(orderSn: string, folderPath: string): Promise<void> {
  const statement = await getAsyncDb().prepare('UPDATE orders SET folder_path = ? WHERE order_sn = ?')
  await statement.run([folderPath, orderSn])
}

/** Guarda o último checkpoint do rastreio, que é detalhe do pedido. */
export async function setLogisticsStatusAsync(
  orderSn: string,
  status: string,
  deliveredAt: number | null
): Promise<void> {
  const statement = await getAsyncDb().prepare(
    `UPDATE orders SET logistics_status = ?, delivered_at = COALESCE(?, delivered_at)
      WHERE order_sn = ?`
  )
  await statement.run([status, deliveredAt, orderSn])
}

export async function setRatingAsync(
  orderSn: string,
  star: number,
  comment: string | null,
  ratedAt: number | null
): Promise<void> {
  const statement = await getAsyncDb().prepare(
    'UPDATE orders SET rating_star = ?, rating_comment = ?, rated_at = COALESCE(?, rated_at) WHERE order_sn = ?'
  )
  await statement.run([star, comment, ratedAt, orderSn])
}

/**
 * Guarda o valor e a liberação do pedido. `releasedAt` nulo é normal: a Shopee
 * calcula o valor antes de soltar o dinheiro — é o estado "aguardando
 * pagamento". Só entra aqui data que **já passou**; previsão fica no extrato.
 */
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

export async function countAwaitingPaymentAsync(): Promise<number> {
  const statement = await getAsyncDb().prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE ${AWAITING_PAYMENT_WHERE}`
  )
  return ((await statement.get([])) as { n: number }).n
}

/** Os mais antigos primeiro: são os que já deveriam ter sido pagos. */
export async function getStatusHistoryAsync(orderSn: string): Promise<StatusHistoryEntry[]> {
  const statement = await getAsyncDb().prepare(
    'SELECT id, order_sn, from_status, to_status, changed_at FROM status_history WHERE order_sn = ? ORDER BY changed_at DESC'
  )
  const rows = (await statement.all([orderSn])) as {
    id: number; order_sn: string; from_status: string | null; to_status: string; changed_at: number
  }[]
  return rows.map((row) => ({
    id: row.id, orderSn: row.order_sn, fromStatus: row.from_status,
    toStatus: row.to_status, changedAt: row.changed_at
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
    /** Ids do catálogo da Shopee; é o que liga o pedido ao produto. */
    itemId?: string | null
    modelId?: string | null
    pecas?: number | null
  }[]
}

/**
 * Versão não bloqueante usada por importações longas.
 * O cliente síncrono espera a rede na thread do Electron e congela a janela.
 */
export async function upsertShopeeOrderAsync(input: UpsertOrderInput): Promise<boolean> {
  const db = getAsyncDb()
  const get = async <T>(sql: string, params: unknown[]): Promise<T | undefined> => {
    const statement = await db.prepare(sql)
    return (await statement.get(params)) as T | undefined
  }
  const run = async (sql: string, params: unknown[]): Promise<void> => {
    const statement = await db.prepare(sql)
    await statement.run(params)
  }

  const existing = await get<{
    order_sn: string
    shopee_status: string | null
    escrow_released_at: number | null
    logistics_code: number | null
  }>(
    'SELECT order_sn, shopee_status, escrow_released_at, logistics_code FROM orders WHERE order_sn = ?',
    [input.orderSn]
  )
  const now = Date.now()
  if (!existing) {
    await run(
      `INSERT INTO orders (
        order_sn, shopee_order_id, shopee_status, internal_status, buyer_username, buyer_name,
        total_amount, currency, tracking_number, ship_by_date, logistics_code,
        status_description, payment_method, carrier, shipping_city, shopee_url_path,
        package_number, created_at_shopee, updated_at_shopee, synced_at, raw_json
      ) VALUES (?, ?, ?, 'NOVO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.orderSn, input.shopeeOrderId ?? null, input.shopeeStatus ?? null,
        input.buyerUsername ?? null, input.buyerName ?? null, input.totalAmount ?? null,
        input.currency ?? null, input.trackingNumber ?? null, input.shipByDate ?? null,
        input.logisticsCode ?? null, input.statusDescription ?? null, input.paymentMethod ?? null,
        input.carrier ?? null, input.shippingCity ?? null, input.shopeeUrlPath ?? null,
        input.packageNumber ?? null, input.createdAtShopee ?? null, input.updatedAtShopee ?? null,
        now, input.rawJson ?? null
      ]
    )
    await run(
      'INSERT INTO status_history (order_sn, from_status, to_status, changed_at) VALUES (?, NULL, ?, ?)',
      [input.orderSn, 'NOVO', now]
    )
  } else {
    await run(
      `UPDATE orders SET
        shopee_order_id = COALESCE(?, shopee_order_id), shopee_status = COALESCE(?, shopee_status),
        buyer_username = COALESCE(?, buyer_username), buyer_name = COALESCE(?, buyer_name),
        total_amount = COALESCE(?, total_amount), currency = COALESCE(?, currency),
        tracking_number = COALESCE(?, tracking_number), ship_by_date = COALESCE(?, ship_by_date),
        logistics_code = COALESCE(?, logistics_code), status_description = COALESCE(?, status_description),
        payment_method = COALESCE(?, payment_method), carrier = COALESCE(?, carrier),
        shipping_city = COALESCE(?, shipping_city), shopee_url_path = COALESCE(?, shopee_url_path),
        package_number = COALESCE(?, package_number), created_at_shopee = COALESCE(?, created_at_shopee),
        updated_at_shopee = COALESCE(?, updated_at_shopee), synced_at = ?,
        raw_json = COALESCE(?, raw_json) WHERE order_sn = ?`,
      [
        input.shopeeOrderId ?? null, input.shopeeStatus ?? null, input.buyerUsername ?? null,
        input.buyerName ?? null, input.totalAmount ?? null, input.currency ?? null,
        input.trackingNumber ?? null, input.shipByDate ?? null, input.logisticsCode ?? null,
        input.statusDescription ?? null, input.paymentMethod ?? null, input.carrier ?? null,
        input.shippingCity ?? null, input.shopeeUrlPath ?? null, input.packageNumber ?? null,
        input.createdAtShopee ?? null, input.updatedAtShopee ?? null, now,
        input.rawJson ?? null, input.orderSn
      ]
    )
  }

  if (input.items && input.items.length > 0) {
    await run('DELETE FROM order_items WHERE order_sn = ?', [input.orderSn])
    for (const item of input.items) {
      await run(
        `INSERT INTO order_items
          (order_sn, item_name, model_name, quantity, image_url, item_sku, pecas, item_id, model_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.orderSn, item.itemName, item.modelName, item.quantity, item.imageUrl, item.itemSku,
          item.pecas ?? null, item.itemId ?? null, item.modelId ?? null]
      )
    }
  }

  const tab = deriveTab({
    shopeeStatus: input.shopeeStatus ?? existing?.shopee_status ?? null,
    escrowReleasedAt: existing?.escrow_released_at ?? null
  })
  await run('UPDATE orders SET tab = ?, ready_to_post = ? WHERE order_sn = ?', [
    tab, isReadyToPost(input.logisticsCode ?? existing?.logistics_code ?? null) ? 1 : 0, input.orderSn
  ])
  return !existing
}
