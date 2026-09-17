import { createClient, type Client } from '@libsql/client/web'
import { ORDER_TABS, type MetricaPainel, type Order, type OrderCounts, type OrderTab, type Painel, type ResumoPeriodo, type SerieMensal, type TabCounts } from '../shared/types'

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  TURSO_DATABASE_URL: string
  TURSO_AUTH_TOKEN: string
}

type Row = Record<string, unknown>

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
  })
}

function number(row: Row | undefined, key: string): number {
  const value = row?.[key]
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function saoPauloDate(daysAgo = 0): string {
  const now = new Date(Date.now() - daysAgo * 86_400_000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function dayMs(daysAgo = 0): number {
  return new Date(`${saoPauloDate(daysAgo)}T00:00:00-03:00`).getTime()
}

function period(row: Row, prefix: 'hoje' | 'sete' | 'trinta'): ResumoPeriodo {
  return {
    pedidos: number(row, `${prefix}_pedidos`), vendas: Number(number(row, `${prefix}_vendas`).toFixed(2)),
    caixas: number(row, `${prefix}_caixas`), recebido: Number(number(row, `${prefix}_recebido`).toFixed(2)),
    pedidosRecebidos: number(row, `${prefix}_pedidos_recebidos`), despachados: number(row, `${prefix}_despachados`)
  }
}

async function dashboard(db: Client): Promise<Painel> {
  const result = await db.execute({
    sql: `WITH limites AS (SELECT ? AS hoje, ? AS sete, ? AS trinta, ? AS amanha, ? AS prazo),
      pedidos AS (SELECT
        COUNT(CASE WHEN created_at_shopee >= limites.hoje THEN 1 END) AS hoje_pedidos,
        COUNT(CASE WHEN created_at_shopee >= limites.sete THEN 1 END) AS sete_pedidos,
        COUNT(CASE WHEN created_at_shopee >= limites.trinta THEN 1 END) AS trinta_pedidos,
        COALESCE(SUM(CASE WHEN created_at_shopee >= limites.hoje THEN total_amount ELSE 0 END),0) AS hoje_vendas,
        COALESCE(SUM(CASE WHEN created_at_shopee >= limites.sete THEN total_amount ELSE 0 END),0) AS sete_vendas,
        COALESCE(SUM(CASE WHEN created_at_shopee >= limites.trinta THEN total_amount ELSE 0 END),0) AS trinta_vendas,
        COUNT(CASE WHEN tab='A_ENVIAR' THEN 1 END) AS a_enviar,
        COUNT(CASE WHEN tab='A_ENVIAR' AND ready_to_post=1 THEN 1 END) AS prontos,
        COUNT(CASE WHEN tab='ENVIADO' THEN 1 END) AS em_transito,
        COUNT(CASE WHEN tab='A_ENVIAR' AND ship_by_date IS NOT NULL AND ship_by_date<=limites.prazo THEN 1 END) AS prazo_apertado
        FROM orders, limites WHERE created_at_shopee<limites.amanha AND tab!='CANCELADO'),
      caixas AS (SELECT
        COALESCE(SUM(CASE WHEN o.created_at_shopee>=limites.hoje THEN i.pecas*i.quantity ELSE 0 END),0) AS hoje_caixas,
        COALESCE(SUM(CASE WHEN o.created_at_shopee>=limites.sete THEN i.pecas*i.quantity ELSE 0 END),0) AS sete_caixas,
        COALESCE(SUM(CASE WHEN o.created_at_shopee>=limites.trinta THEN i.pecas*i.quantity ELSE 0 END),0) AS trinta_caixas
        FROM order_items i JOIN orders o ON o.order_sn=i.order_sn, limites
        WHERE o.created_at_shopee<limites.amanha AND o.tab!='CANCELADO' AND i.pecas IS NOT NULL),
      recebidos AS (SELECT
        COALESCE(SUM(CASE WHEN recebido_em>=limites.hoje AND recebido_em<limites.amanha THEN valor_recebido ELSE 0 END),0) AS hoje_recebido,
        COALESCE(SUM(CASE WHEN recebido_em>=limites.sete AND recebido_em<limites.amanha THEN valor_recebido ELSE 0 END),0) AS sete_recebido,
        COALESCE(SUM(CASE WHEN recebido_em>=limites.trinta AND recebido_em<limites.amanha THEN valor_recebido ELSE 0 END),0) AS trinta_recebido,
        COUNT(CASE WHEN recebido_em>=limites.hoje AND recebido_em<limites.amanha THEN 1 END) AS hoje_pedidos_recebidos,
        COUNT(CASE WHEN recebido_em>=limites.sete AND recebido_em<limites.amanha THEN 1 END) AS sete_pedidos_recebidos,
        COUNT(CASE WHEN recebido_em>=limites.trinta AND recebido_em<limites.amanha THEN 1 END) AS trinta_pedidos_recebidos FROM order_income, limites),
      despachos AS (SELECT
        COUNT(DISTINCT CASE WHEN happened_at>=limites.hoje THEN order_sn END) AS hoje_despachados,
        COUNT(DISTINCT CASE WHEN happened_at>=limites.sete THEN order_sn END) AS sete_despachados,
        COUNT(DISTINCT CASE WHEN happened_at>=limites.trinta THEN order_sn END) AS trinta_despachados
        FROM order_events, limites WHERE source='logistics' AND happened_at<limites.amanha AND LOWER(description) LIKE '%postado%'),
      pendentes AS (SELECT COALESCE(SUM(i.valor_recebido),0) AS a_receber, COUNT(*) AS pedidos_a_receber
        FROM order_income i JOIN orders o ON o.order_sn=i.order_sn WHERE i.recebido_em IS NULL AND o.tab!='CANCELADO')
      SELECT * FROM pedidos, caixas, recebidos, despachos, pendentes`,
    args: [dayMs(), dayMs(6), dayMs(29), dayMs(-1), Date.now() + 86_400_000]
  })
  const row = result.rows[0] as Row
  return {
    hoje: period(row, 'hoje'), ultimos7: period(row, 'sete'), ultimos30: period(row, 'trinta'),
    aEnviar: number(row, 'a_enviar'), prontosParaPostar: number(row, 'prontos'), emTransito: number(row, 'em_transito'),
    aReceber: Number(number(row, 'a_receber').toFixed(2)), pedidosAReceber: number(row, 'pedidos_a_receber'),
    prazoApertado: number(row, 'prazo_apertado')
  }
}

async function monthlySeries(db: Client, metric: MetricaPainel, year: number, month: number): Promise<SerieMensal> {
  const expressions: Record<MetricaPainel, { from: string; where: string; value: string; date: string }> = {
    pedidos: { from: 'orders', where: "tab!='CANCELADO'", value: 'COUNT(*)', date: 'created_at_shopee' },
    vendas: { from: 'orders', where: "tab!='CANCELADO'", value: 'COALESCE(SUM(total_amount),0)', date: 'created_at_shopee' },
    recebido: { from: 'order_income', where: 'recebido_em IS NOT NULL', value: 'COALESCE(SUM(valor_recebido),0)', date: 'recebido_em' },
    despachados: { from: 'order_events', where: "source='logistics' AND LOWER(description) LIKE '%postado%'", value: 'COUNT(DISTINCT order_sn)', date: 'happened_at' },
    caixas: { from: 'order_items i JOIN orders o ON o.order_sn=i.order_sn', where: "o.tab!='CANCELADO' AND i.pecas IS NOT NULL", value: 'COALESCE(SUM(i.pecas*i.quantity),0)', date: 'o.created_at_shopee' }
  }
  const selected = expressions[metric]
  if (!selected || !Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('Período inválido.')
  const monthText = `${year}-${String(month).padStart(2, '0')}`
  const result = await db.execute({ sql: `SELECT strftime('%d', ${selected.date}/1000, 'unixepoch', '-3 hours') AS dia, ${selected.value} AS value FROM ${selected.from} WHERE ${selected.where} AND strftime('%Y-%m', ${selected.date}/1000, 'unixepoch', '-3 hours')=? GROUP BY dia`, args: [monthText] })
  const byDay = new Map(result.rows.map((row) => [Number(row.dia), Number(row.value)]))
  const days = Array.from({ length: new Date(year, month, 0).getDate() }, (_, index) => ({ dia: index + 1, valor: Number((byDay.get(index + 1) ?? 0).toFixed(2)) }))
  return { metrica: metric, ano: year, mes: month, dias: days, total: Number(days.reduce((sum, day) => sum + day.valor, 0).toFixed(2)) }
}

async function orders(db: Client, url: URL): Promise<{ orders: Order[]; counts: OrderCounts }> {
  const requestedTab = url.searchParams.get('tab') ?? 'A_ENVIAR'
  if (requestedTab !== 'TODOS' && !ORDER_TABS.includes(requestedTab as OrderTab)) throw new Error('Aba inválida.')
  const search = (url.searchParams.get('search') ?? '').trim().slice(0, 100)
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
  const conditions = [requestedTab === 'TODOS' ? "o.tab!='CANCELADO'" : 'o.tab=?']
  const args: Array<string | number> = requestedTab === 'TODOS' ? [] : [requestedTab]
  if (search) {
    conditions.push(`(LOWER(o.order_sn) LIKE LOWER(?) OR LOWER(COALESCE(o.buyer_username,'')) LIKE LOWER(?) OR
      LOWER(COALESCE(o.child_name,'')) LIKE LOWER(?) OR EXISTS (SELECT 1 FROM order_items si WHERE si.order_sn=o.order_sn AND (LOWER(si.item_name) LIKE LOWER(?) OR LOWER(COALESCE(si.model_name,'')) LIKE LOWER(?))))`)
    const like = `%${search}%`; args.push(like, like, like, like, like)
  }
  args.push(limit)
  const results = await db.batch([
    { sql: `SELECT o.order_sn,o.shopee_order_id,o.shopee_status,o.internal_status,o.buyer_username,o.buyer_name,
      o.total_amount,o.currency,o.child_name,o.note,o.tracking_number,o.ship_by_date,o.created_at_shopee,
      o.updated_at_shopee,o.synced_at,o.logistics_status,o.tab,o.ready_to_post,o.status_description,
      o.payment_method,o.carrier,o.shipping_city,o.shopee_url_path,o.package_number,o.stage_id,
      o.delivered_at,o.rating_star,o.rating_comment,o.rated_at,o.escrow_amount,o.escrow_released_at,
      s.name AS stage_name,s.color AS stage_color,
      i.valor_produtos,i.valor_frete,i.frete_pago_comprador,i.custo_frete,i.subsidio_frete_shopee,
      i.desconto_cupons,i.taxa_comissao,i.taxa_servico,i.outras_taxas,i.valor_recebido,i.recebido_em,i.previsto_para,
      COALESCE((SELECT json_group_array(json_object('id',oi.id,'itemName',oi.item_name,'modelName',oi.model_name,'quantity',oi.quantity,'imageUrl',oi.image_url,'itemSku',oi.item_sku,'pecas',oi.pecas)) FROM order_items oi WHERE oi.order_sn=o.order_sn),'[]') AS items
      FROM orders o LEFT JOIN workflow_stages s ON s.id=o.stage_id LEFT JOIN order_income i ON i.order_sn=o.order_sn
      WHERE ${conditions.join(' AND ')} ORDER BY o.created_at_shopee DESC,o.order_sn DESC LIMIT ?`, args },
    { sql: 'SELECT tab,COUNT(*) AS total FROM orders WHERE tab IS NOT NULL GROUP BY tab', args: [] },
    { sql: "SELECT COUNT(*) AS total FROM orders WHERE ready_to_post=1 AND tab='A_ENVIAR'", args: [] },
    { sql: `SELECT COUNT(*) AS total FROM orders o LEFT JOIN order_income i ON i.order_sn=o.order_sn WHERE o.tab='CONCLUIDO' AND o.shopee_order_id IS NOT NULL AND i.order_sn IS NULL`, args: [] }
  ], 'read')
  const tabs = Object.fromEntries(ORDER_TABS.map((tab) => [tab, 0])) as TabCounts
  for (const row of results[1].rows) if (String(row.tab) in tabs) tabs[String(row.tab) as OrderTab] = Number(row.total)
  const mapped = results[0].rows.map((row): Order => {
    const fees = ['taxa_comissao', 'taxa_servico', 'outras_taxas'].reduce((sum, key) => sum + Math.abs(Number(row[key] ?? 0)), 0)
    const hasIncome = row.valor_recebido !== null || row.valor_produtos !== null
    const parsedItems = JSON.parse(String(row.items ?? '[]')) as Array<Record<string, unknown>>
    return {
      orderSn: String(row.order_sn), shopeeOrderId: row.shopee_order_id === null ? null : String(row.shopee_order_id),
      shopeeStatus: row.shopee_status === null ? null : String(row.shopee_status), tab: String(row.tab) as OrderTab,
      readyToPost: Number(row.ready_to_post) === 1, statusDescription: row.status_description === null ? null : String(row.status_description),
      paymentMethod: row.payment_method === null ? null : String(row.payment_method), carrier: row.carrier === null ? null : String(row.carrier),
      shippingCity: row.shipping_city === null ? null : String(row.shipping_city), shopeeUrlPath: null,
      packageNumber: row.package_number === null ? null : String(row.package_number), stageId: row.stage_id === null ? null : Number(row.stage_id),
      stageName: row.stage_name === null ? null : String(row.stage_name), stageColor: row.stage_color === null ? null : String(row.stage_color),
      internalStatus: String(row.internal_status) as Order['internalStatus'], buyerUsername: row.buyer_username === null ? null : String(row.buyer_username),
      buyerName: row.buyer_name === null ? null : String(row.buyer_name), totalAmount: row.total_amount === null ? null : Number(row.total_amount),
      currency: row.currency === null ? null : String(row.currency), childName: row.child_name === null ? null : String(row.child_name),
      note: row.note === null ? null : String(row.note), trackingNumber: row.tracking_number === null ? null : String(row.tracking_number),
      shipByDate: row.ship_by_date === null ? null : Number(row.ship_by_date), folderPath: null,
      createdAtShopee: row.created_at_shopee === null ? null : Number(row.created_at_shopee), updatedAtShopee: row.updated_at_shopee === null ? null : Number(row.updated_at_shopee),
      syncedAt: row.synced_at === null ? null : Number(row.synced_at), logisticsStatus: row.logistics_status === null ? null : String(row.logistics_status),
      deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at), ratingStar: row.rating_star === null ? null : Number(row.rating_star),
      ratingComment: row.rating_comment === null ? null : String(row.rating_comment), ratedAt: row.rated_at === null ? null : Number(row.rated_at),
      escrowAmount: row.escrow_amount === null ? null : Number(row.escrow_amount), escrowReleasedAt: row.escrow_released_at === null ? null : Number(row.escrow_released_at),
      recebimento: hasIncome ? { valorProdutos: row.valor_produtos === null ? null : Number(row.valor_produtos), valorFrete: row.valor_frete === null ? null : Number(row.valor_frete), fretePagoComprador: row.frete_pago_comprador === null ? null : Number(row.frete_pago_comprador), custoFrete: row.custo_frete === null ? null : Number(row.custo_frete), subsidioFreteShopee: row.subsidio_frete_shopee === null ? null : Number(row.subsidio_frete_shopee), descontoCupons: row.desconto_cupons === null ? null : Number(row.desconto_cupons), taxaComissao: row.taxa_comissao === null ? null : Number(row.taxa_comissao), taxaServico: row.taxa_servico === null ? null : Number(row.taxa_servico), outrasTaxas: row.outras_taxas === null ? null : Number(row.outras_taxas), totalTaxas: fees || null, valorRecebido: row.valor_recebido === null ? null : Number(row.valor_recebido), recebidoEm: row.recebido_em === null ? null : Number(row.recebido_em), previstoPara: row.previsto_para === null ? null : Number(row.previsto_para) } : null,
      items: parsedItems.map((item) => ({ id: Number(item.id), orderSn: String(row.order_sn), itemName: String(item.itemName), modelName: item.modelName === null ? null : String(item.modelName), quantity: Number(item.quantity), imageUrl: item.imageUrl === null ? null : String(item.imageUrl), itemSku: item.itemSku === null ? null : String(item.itemSku), pecas: item.pecas === null ? null : Number(item.pecas) }))
    }
  })
  return { orders: mapped, counts: { tabs, readyToPost: number(results[2].rows[0] as Row, 'total'), semExtrato: number(results[3].rows[0] as Row, 'total') } }
}

async function production(db: Client): Promise<unknown> {
  const results = await db.batch([
    { sql: `SELECT i.id,i.name,i.kind,i.unit,i.sellable,i.stock_controlled,i.reference_cost,i.waste_percent,
      COALESCE((SELECT SUM(m.quantity) FROM composition_stock_moves m WHERE m.item_id=i.id),0) AS stock,
      (SELECT CASE WHEN SUM(p.quantity)>0 THEN SUM(p.total+p.shipping)/SUM(p.quantity) END FROM composition_purchases p WHERE p.item_id=i.id) AS average_cost,
      (SELECT COUNT(*) FROM composition_parts p WHERE p.parent_item_id=i.id) AS parts FROM composition_items i ORDER BY i.kind,i.name`, args: [] },
    { sql: `SELECT p.id,p.bought_at,i.name AS item_name,v.name AS variant_name,p.quantity,p.total,p.shipping,p.supplier,i.unit FROM composition_purchases p JOIN composition_items i ON i.id=p.item_id LEFT JOIN composition_variants v ON v.id=p.variant_id ORDER BY p.bought_at DESC,p.id DESC LIMIT 100`, args: [] },
    { sql: `SELECT l.id,l.produced_at,i.name AS item_name,v.name AS variant_name,l.quantity,l.estimated_unit_cost,l.actual_total_cost,l.notes FROM composition_production_lots l JOIN composition_items i ON i.id=l.item_id LEFT JOIN composition_variants v ON v.id=l.variant_id ORDER BY l.produced_at DESC,l.id DESC LIMIT 100`, args: [] }
  ], 'read')
  return { items: results[0].rows, purchases: results[1].rows, lots: results[2].rows }
}

async function api(request: Request, env: Env): Promise<Response> {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) return json({ error: 'Conexão com o Turso não configurada.' }, 503)
  const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })
  const url = new URL(request.url)
  try {
    if (request.method === 'GET' && url.pathname === '/api/dashboard') return json(await dashboard(db))
    if (request.method === 'GET' && url.pathname === '/api/dashboard/series') return json(await monthlySeries(db, url.searchParams.get('metric') as MetricaPainel, Number(url.searchParams.get('year')), Number(url.searchParams.get('month'))))
    if (request.method === 'GET' && url.pathname === '/api/orders') return json(await orders(db, url))
    if (request.method === 'GET' && url.pathname === '/api/production') return json(await production(db))
    return json({ error: 'Rota não encontrada.' }, 404)
  } catch (error) {
    console.error('Falha na API web:', error instanceof Error ? error.message : 'erro desconhecido')
    return json({ error: 'Não foi possível carregar os dados.' }, 500)
  } finally { db.close() }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Falha fechada: um deploy nunca pode expor o CRM caso a aplicação Access
    // ainda não exista ou seja removida por engano. O Access inclui este JWT
    // somente depois de autenticar uma identidade permitida.
    if (!request.headers.get('Cf-Access-Jwt-Assertion')) {
      return new Response('Acesso privado não configurado.', {
        status: 403,
        headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
      })
    }
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) return api(request, env)
    return env.ASSETS.fetch(request)
  }
}
