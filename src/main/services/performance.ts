import { session as electronSession } from 'electron'
import type { DesempenhoProduto, PeriodoDesempenho, ResumoDesempenho, ResultadoSyncDesempenho } from '@shared/types'
import { getAsyncDb } from '../db'
import { pageFetchJson, ShopeeApiError, shopeePartition } from './shopee/session'

type Obj = Record<string, unknown>
const SHOPEE_ADS_MONEY_UNIT = 100000

/** Compatibilidade com snapshots gravados antes da conversão do Shopee Ads. */
function adsMoney(value: number): number {
  return Math.abs(value) >= SHOPEE_ADS_MONEY_UNIT ? value / SHOPEE_ADS_MONEY_UNIT : value
}

function obj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
}

function array(value: unknown): Obj[] {
  return Array.isArray(value) ? value.map(obj) : []
}

function number(source: Obj, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return 0
}

function string(source: Obj, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' || typeof value === 'number') return String(value)
  }
  return ''
}

function productImage(source: Obj): string | null {
  const value = string(source, 'image', 'image_url')
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value
  return `https://down-br.img.susercontent.com/file/${encodeURIComponent(value)}`
}

function data(response: unknown): Obj {
  return obj(obj(response).data)
}

async function fetchPerformance(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await pageFetchJson(path, init)
    } catch (error) {
      lastError = error
      const transient = error instanceof ShopeeApiError &&
        (error.httpStatus === 0 || error.httpStatus === 429 || error.httpStatus >= 500)
      if (!transient || attempt === 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw lastError
}

async function cds(): Promise<string> {
  const cookies = await electronSession.fromPartition(shopeePartition()).cookies.get({ name: 'SPC_CDS' })
  return cookies[0]?.value ?? ''
}

function apiPeriod(days: 7 | 30): { start: number; end: number; adsEnd: number; apiPeriod: string } {
  const now = new Date()
  const startDate = new Date(now)
  const endDate = new Date(now)
  startDate.setDate(startDate.getDate() - days + 1)
  startDate.setHours(0, 0, 0, 0)
  const adsEndDate = new Date(endDate)
  adsEndDate.setHours(23, 59, 59, 0)
  return {
    start: Math.floor(startDate.getTime() / 1000),
    end: Math.floor(endDate.getTime() / 1000),
    adsEnd: Math.floor(adsEndDate.getTime() / 1000),
    apiPeriod: days === 7 ? 'past7days' : 'past30days'
  }
}

function metricPoints(response: unknown, key: string): Map<number, number> {
  const result = obj(obj(response).result ?? data(response).result)
  const points = array(obj(result[key]).points)
  return new Map(points.map((point) => [dayTimestamp(number(point, 'timestamp')), number(point, 'value')]))
}

function dayTimestamp(value: number | string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000)
    date.setHours(0, 0, 0, 0)
    return Math.floor(date.getTime() / 1000)
  }
  const text = String(value)
  if (/^\d{10,13}$/.test(text)) return dayTimestamp(Number(text))
  const br = /^(\d{2})[\/-](\d{2})[\/-](\d{4})$/.exec(text)
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  const normalized = br ? `${br[3]}-${br[2]}-${br[1]}` : compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : text
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? `${normalized}T00:00:00` : normalized
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 0
  date.setHours(0, 0, 0, 0)
  return Math.floor(date.getTime() / 1000)
}

export async function sincronizarDesempenho(period?: PeriodoDesempenho): Promise<ResultadoSyncDesempenho> {
  void period
  const existing = await (await getAsyncDb().prepare('SELECT COUNT(*) AS total FROM daily_performance')).get() as { total?: number } | undefined
  const days: 7 | 30 = Number(existing?.total ?? 0) === 0 ? 30 : 7
  const { start, end, adsEnd, apiPeriod: shopeePeriod } = apiPeriod(days)
  // Esta primeira chamada também abre a página base do Seller Center. Só
  // depois dela o portal cria o SPC_CDS usado pelas APIs de marketing.
  const productsResponse = await fetchPerformance(
    `/api/mydata/v4/product/performance/?start_time=${start}&end_time=${end}&period=${shopeePeriod}&keyword=&category_type=shopee&category_id=-1&page_size=100&page_num=1&order_type=paid&order_by=paid_sales.desc`
  )
  const sessionToken = await cds()
  if (!sessionToken) {
    throw new Error('A Shopee não liberou a sessão de marketing. Entre novamente na conta e tente de novo.')
  }
  const token = encodeURIComponent(sessionToken)
  const auth = `SPC_CDS=${token}&SPC_CDS_VER=2`

  // Após inicializar a sessão, as três áreas de marketing são independentes e
  // podem ser buscadas em paralelo. Não entram na sincronização de pedidos.
  const [shopResponse, adsResponse, flashListResponse, flashMetricsResponse] = await Promise.all([
    fetchPerformance(`/api/mydata/v3/dashboard/key-metrics/?start_time=${start}&end_time=${end}&period=${shopeePeriod}&fetag=fetag`),
    fetchPerformance(`/api/pas/v1/report/get_time_graph/?${auth}`, {
      method: 'POST',
      body: {
        agg_interval: 96,
        campaign_type: 'product_homepage_v2',
        start_time: start,
        end_time: adsEnd,
        need_roi_target_setting: false,
        filter_params: { campaign_type: 'new_cpc_homepage' }
      }
    }),
    fetchPerformance(`/api/marketing/v4/shop_flash_sale/get_shop_flash_sale_list/?${auth}&offset=0&limit=100&type=0`),
    fetchPerformance(`/api/marketing/v4/public/get_promotion_tool_metrics/?${auth}&tool_name=marketing_shop_flash_sale`)
  ])

  const productEnvelope = obj(productsResponse)
  const productData = data(productsResponse)
  const productResult = obj(productEnvelope.result ?? productData.result ?? productData)
  const productRows = array(productResult.items ?? productResult.list)
  const products = productRows.map((row) => {
    const metrics = obj(row.metrics ?? row.performance ?? row)
    return {
      itemId: string(row, 'item_id', 'id'),
      name: string(row, 'item_name', 'name', 'product_name') || 'Produto sem nome',
      imageUrl: productImage(row),
      impressions: number(metrics, 'product_card_impressions', 'impressions', 'impression', 'product_impression'),
      clicks: number(metrics, 'product_card_clicks', 'clicks', 'click', 'product_clicks'),
      visitors: number(metrics, 'uv', 'unique_visitors', 'visitors'),
      likes: number(metrics, 'likes', 'like_count'),
      carts: number(metrics, 'add_to_cart_buyers', 'add_to_cart_users', 'cart_buyers'),
      orders: number(metrics, 'paid_orders', 'placed_orders', 'confirmed_orders', 'orders'),
      units: number(metrics, 'paid_units', 'placed_units', 'confirmed_units', 'units'),
      sales: number(metrics, 'paid_sales', 'placed_sales', 'confirmed_sales', 'sales')
    }
  }).filter((row) => row.itemId)

  const aggregate = obj(data(adsResponse).report_aggregate)
  const ads = {
    impressions: number(aggregate, 'impression', 'product_impression'),
    clicks: number(aggregate, 'click', 'product_click'),
    orders: number(aggregate, 'broad_order', 'direct_order', 'order'),
    units: number(aggregate, 'broad_order_amount', 'direct_order_amount', 'order_amount'),
    // Shopee Ads usa micro-unidades (100000 = R$ 1,00). A API de produtos e
    // a de Oferta Relâmpago, por outro lado, já devolvem reais.
    sales: number(aggregate, 'broad_gmv', 'direct_gmv', 'gmv') / SHOPEE_ADS_MONEY_UNIT,
    cost: number(aggregate, 'cost') / SHOPEE_ADS_MONEY_UNIT
  }

  const flashData = data(flashListResponse)
  const flashRows = array(flashData.flash_sale_list)
  const flashIds = flashRows.map((row) => string(row, 'flash_sale_id')).filter(Boolean)
  const flashReportResponse = flashIds.length === 0 ? null : await fetchPerformance(
    `/api/marketing/v4/shop_flash_sale/report_shop_flash_sale/?${auth}&promotion_id_list=${encodeURIComponent(JSON.stringify(flashIds.map(Number)))}`
  )
  const flashReports = array(data(flashReportResponse))
  const flashMetricsData = obj(data(flashMetricsResponse).data ?? data(flashMetricsResponse))
  const syncedAt = Date.now()
  const statements: { sql: string; parameters?: unknown[] }[] = [
    {
      sql: `INSERT INTO performance_snapshots (
        period_start, period_end, synced_at, impressions, clicks, orders_count, units, sales,
        ads_impressions, ads_clicks, ads_orders, ads_sales, ads_cost,
        flash_viewers, flash_impressions, flash_clicks, flash_orders, flash_units, flash_sales
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(period_start, period_end) DO UPDATE SET
        synced_at=excluded.synced_at, impressions=excluded.impressions, clicks=excluded.clicks,
        orders_count=excluded.orders_count, units=excluded.units, sales=excluded.sales,
        ads_impressions=excluded.ads_impressions, ads_clicks=excluded.ads_clicks,
        ads_orders=excluded.ads_orders, ads_sales=excluded.ads_sales, ads_cost=excluded.ads_cost,
        flash_viewers=excluded.flash_viewers, flash_impressions=excluded.flash_impressions,
        flash_clicks=excluded.flash_clicks, flash_orders=excluded.flash_orders,
        flash_units=excluded.flash_units, flash_sales=excluded.flash_sales`,
      parameters: [start, end, syncedAt,
        products.reduce((sum, row) => sum + row.impressions, 0),
        products.reduce((sum, row) => sum + row.clicks, 0),
        products.reduce((sum, row) => sum + row.orders, 0),
        products.reduce((sum, row) => sum + row.units, 0),
        products.reduce((sum, row) => sum + row.sales, 0),
        ads.impressions, ads.clicks, ads.orders, ads.sales, ads.cost,
        number(flashMetricsData, 'viewers'), number(flashMetricsData, 'product_impression'),
        number(flashMetricsData, 'product_clicks'), number(flashMetricsData, 'orders'),
        number(flashMetricsData, 'units'), number(flashMetricsData, 'sales')]
    },
    { sql: `DELETE FROM product_performance WHERE snapshot_id=(SELECT id FROM performance_snapshots WHERE period_start=? AND period_end=?)`, parameters: [start, end] },
    { sql: `DELETE FROM flash_sale_performance WHERE snapshot_id=(SELECT id FROM performance_snapshots WHERE period_start=? AND period_end=?)`, parameters: [start, end] }
  ]
  for (const row of products) statements.push({
    sql: `INSERT INTO product_performance (snapshot_id,item_id,name,image_url,impressions,clicks,visitors,likes,add_to_cart_buyers,orders_count,units,sales)
      VALUES ((SELECT id FROM performance_snapshots WHERE period_start=? AND period_end=?),?,?,?,?,?,?,?,?,?,?,?)`,
    parameters: [start, end, row.itemId, row.name, row.imageUrl, row.impressions, row.clicks, row.visitors, row.likes, row.carts, row.orders, row.units, row.sales]
  })
  flashRows.forEach((row, index) => statements.push({
    sql: `INSERT INTO flash_sale_performance (snapshot_id,flash_sale_id,start_time,end_time,status,item_count,enabled_item_count,clicks)
      VALUES ((SELECT id FROM performance_snapshots WHERE period_start=? AND period_end=?),?,?,?,?,?,?,?)`,
    parameters: [start, end, string(row, 'flash_sale_id'), number(row, 'start_time'), number(row, 'end_time'), number(row, 'status'), number(row, 'item_count'), number(row, 'enabled_item_count'), number(flashReports[index] ?? {}, 'click_cnt')]
  }))

  const shopViews = metricPoints(shopResponse, 'shop_pv')
  const shopVisitors = metricPoints(shopResponse, 'shop_uv')
  const shopClicks = metricPoints(shopResponse, 'product_clicks')
  const shopOrders = metricPoints(shopResponse, 'paid_orders')
  const shopSales = metricPoints(shopResponse, 'paid_gmv')
  const daily = new Map<number, { hasShop: boolean; hasAds: boolean; views: number; visitors: number; clicks: number; orders: number; sales: number; adsImpressions: number; adsClicks: number; adsOrders: number; adsSales: number; adsCost: number }>()
  const rowFor = (day: number) => {
    const current = daily.get(day) ?? { hasShop: false, hasAds: false, views: 0, visitors: 0, clicks: 0, orders: 0, sales: 0, adsImpressions: 0, adsClicks: 0, adsOrders: 0, adsSales: 0, adsCost: 0 }
    daily.set(day, current)
    return current
  }
  for (const day of new Set([...shopViews.keys(), ...shopVisitors.keys(), ...shopClicks.keys(), ...shopOrders.keys(), ...shopSales.keys()])) {
    Object.assign(rowFor(day), { hasShop: true, views: shopViews.get(day) ?? 0, visitors: shopVisitors.get(day) ?? 0, clicks: shopClicks.get(day) ?? 0, orders: shopOrders.get(day) ?? 0, sales: shopSales.get(day) ?? 0 })
  }
  for (const report of array(data(adsResponse).report_by_time)) {
    const day = dayTimestamp(string(report, 'key'))
    if (!day) continue
    const metrics = obj(report.metrics)
    Object.assign(rowFor(day), { hasAds: true,
      adsImpressions: number(metrics, 'impression', 'product_impression'), adsClicks: number(metrics, 'click', 'product_click'),
      adsOrders: number(metrics, 'broad_order', 'direct_order'), adsSales: number(metrics, 'broad_gmv', 'direct_gmv') / SHOPEE_ADS_MONEY_UNIT,
      adsCost: number(metrics, 'cost') / SHOPEE_ADS_MONEY_UNIT
    })
  }
  for (const [day, row] of daily) statements.push({
    sql: `INSERT INTO daily_performance (day,synced_at,shop_views,shop_visitors,product_clicks,orders_count,sales,ads_impressions,ads_clicks,ads_orders,ads_sales,ads_cost)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET synced_at=excluded.synced_at,
      shop_views=CASE WHEN ?=1 THEN excluded.shop_views ELSE shop_views END, shop_visitors=CASE WHEN ?=1 THEN excluded.shop_visitors ELSE shop_visitors END,
      product_clicks=CASE WHEN ?=1 THEN excluded.product_clicks ELSE product_clicks END, orders_count=CASE WHEN ?=1 THEN excluded.orders_count ELSE orders_count END,
      sales=CASE WHEN ?=1 THEN excluded.sales ELSE sales END, ads_impressions=CASE WHEN ?=1 THEN excluded.ads_impressions ELSE ads_impressions END,
      ads_clicks=CASE WHEN ?=1 THEN excluded.ads_clicks ELSE ads_clicks END, ads_orders=CASE WHEN ?=1 THEN excluded.ads_orders ELSE ads_orders END,
      ads_sales=CASE WHEN ?=1 THEN excluded.ads_sales ELSE ads_sales END, ads_cost=CASE WHEN ?=1 THEN excluded.ads_cost ELSE ads_cost END`,
    parameters: [day, syncedAt, row.views, row.visitors, row.clicks, row.orders, row.sales, row.adsImpressions, row.adsClicks, row.adsOrders, row.adsSales, row.adsCost,
      Number(row.hasShop), Number(row.hasShop), Number(row.hasShop), Number(row.hasShop), Number(row.hasShop),
      Number(row.hasAds), Number(row.hasAds), Number(row.hasAds), Number(row.hasAds), Number(row.hasAds)]
  })
  await getAsyncDb().batch(statements)
  return { produtos: products.length, ofertasRelampago: flashRows.length, sincronizadoEm: syncedAt }
}

interface SnapshotRow {
  period_start: number; period_end: number; synced_at: number; impressions: number; clicks: number
  orders_count: number; units: number; sales: number; ads_impressions: number; ads_clicks: number
  ads_orders: number; ads_sales: number; ads_cost: number; flash_viewers: number
  flash_impressions: number; flash_clicks: number; flash_orders: number; flash_units: number; flash_sales: number
}

function requestedRange(period?: PeriodoDesempenho): { start: number; end: number } {
  const fallbackEnd = new Date(); fallbackEnd.setHours(0, 0, 0, 0)
  const fallbackStart = new Date(fallbackEnd); fallbackStart.setDate(fallbackStart.getDate() - 29)
  if (!period) return { start: Math.floor(fallbackStart.getTime() / 1000), end: Math.floor(fallbackEnd.getTime() / 1000) }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(period.fim)) throw new Error('Período inválido.')
  const start = dayTimestamp(period.inicio)
  const end = dayTimestamp(period.fim)
  if (!start || !end || start > end) throw new Error('A data inicial deve ser anterior à data final.')
  return { start, end }
}

interface DailySummaryRow {
  days: number; synced_at: number; shop_views: number; product_clicks: number; orders_count: number; sales: number
  ads_impressions: number; ads_clicks: number; ads_orders: number; ads_sales: number; ads_cost: number
}

export async function resumoDesempenho(period?: PeriodoDesempenho): Promise<ResumoDesempenho | null> {
  const range = requestedRange(period)
  const [dailyRows, dailyCoverage, snapshots, products, flashCount] = await getAsyncDb().queryBatch([
    { sql: `SELECT COUNT(*) AS days, MAX(synced_at) AS synced_at,
        COALESCE(SUM(shop_views),0) AS shop_views, COALESCE(SUM(product_clicks),0) AS product_clicks,
        COALESCE(SUM(orders_count),0) AS orders_count, COALESCE(SUM(sales),0) AS sales,
        COALESCE(SUM(ads_impressions),0) AS ads_impressions, COALESCE(SUM(ads_clicks),0) AS ads_clicks,
        COALESCE(SUM(ads_orders),0) AS ads_orders, COALESCE(SUM(ads_sales),0) AS ads_sales,
        COALESCE(SUM(ads_cost),0) AS ads_cost FROM daily_performance WHERE day BETWEEN ? AND ?`, parameters: [range.start, range.end] },
    { sql: 'SELECT COUNT(*) AS total FROM daily_performance' },
    { sql: 'SELECT * FROM performance_snapshots ORDER BY synced_at DESC LIMIT 1' },
    { sql: `SELECT pp.* FROM product_performance pp JOIN performance_snapshots ps ON ps.id=pp.snapshot_id WHERE ps.id=(SELECT id FROM performance_snapshots ORDER BY synced_at DESC LIMIT 1) ORDER BY pp.sales DESC, pp.clicks DESC` },
    { sql: `SELECT COUNT(*) AS total FROM flash_sale_performance WHERE snapshot_id=(SELECT id FROM performance_snapshots ORDER BY synced_at DESC LIMIT 1)` }
  ])
  const daily = dailyRows[0] as unknown as DailySummaryRow | undefined
  const row = snapshots[0] as unknown as SnapshotRow | undefined
  const hasDailyHistory = Number((dailyCoverage[0] as { total?: number } | undefined)?.total ?? 0) > 0
  if (!row && !hasDailyHistory) return null
  const productList = products as unknown as Array<Record<string, string | number | null>>
  const useDaily = hasDailyHistory
  const adsSales = useDaily ? Number(daily?.ads_sales ?? 0) : adsMoney(row?.ads_sales ?? 0)
  const adsCost = useDaily ? Number(daily?.ads_cost ?? 0) : adsMoney(row?.ads_cost ?? 0)
  const desempenhoProdutos: DesempenhoProduto[] = productList.map((product) => ({
    itemId: String(product.item_id), nome: String(product.name), imagemUrl: productImage(product as Obj),
    impressoes: Number(product.impressions), cliques: Number(product.clicks), visitantes: Number(product.visitors),
    curtidas: Number(product.likes), adicionaramAoCarrinho: Number(product.add_to_cart_buyers),
    pedidos: Number(product.orders_count), unidades: Number(product.units), vendas: Number(product.sales),
    ctr: Number(product.impressions) > 0 ? Number(product.clicks) / Number(product.impressions) : 0,
    conversao: Number(product.clicks) > 0 ? Number(product.orders_count) / Number(product.clicks) : 0
  }))
  return {
    inicio: range.start * 1000, fim: range.end * 1000, sincronizadoEm: Number(daily?.synced_at ?? row?.synced_at ?? 0),
    geral: { impressoes: useDaily ? Number(daily?.shop_views ?? 0) : Number(row?.impressions ?? 0), cliques: useDaily ? Number(daily?.product_clicks ?? 0) : Number(row?.clicks ?? 0), pedidos: useDaily ? Number(daily?.orders_count ?? 0) : Number(row?.orders_count ?? 0), unidades: useDaily ? 0 : Number(row?.units ?? 0), vendas: useDaily ? Number(daily?.sales ?? 0) : Number(row?.sales ?? 0) },
    ads: { impressoes: useDaily ? Number(daily?.ads_impressions ?? 0) : Number(row?.ads_impressions ?? 0), cliques: useDaily ? Number(daily?.ads_clicks ?? 0) : Number(row?.ads_clicks ?? 0), pedidos: useDaily ? Number(daily?.ads_orders ?? 0) : Number(row?.ads_orders ?? 0), unidades: 0, vendas: adsSales, investimento: adsCost, roas: adsCost > 0 ? adsSales / adsCost : null, cpc: (useDaily ? Number(daily?.ads_clicks ?? 0) : Number(row?.ads_clicks ?? 0)) > 0 ? adsCost / (useDaily ? Number(daily?.ads_clicks ?? 0) : Number(row?.ads_clicks ?? 0)) : null },
    ofertaRelampago: { impressoes: Number(row?.flash_impressions ?? 0), cliques: Number(row?.flash_clicks ?? 0), pedidos: Number(row?.flash_orders ?? 0), unidades: Number(row?.flash_units ?? 0), vendas: Number(row?.flash_sales ?? 0), espectadores: Number(row?.flash_viewers ?? 0), campanhas: Number((flashCount[0] as { total?: number } | undefined)?.total ?? 0) },
    produtos: desempenhoProdutos
  }
}
