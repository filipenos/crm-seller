import { session as electronSession } from 'electron'
import { pageFetchJson, ShopeeApiError, SHOPEE_PARTITION } from './session'

/** Moeda numérica da Shopee → código ISO. 9 = BRL. */
const CURRENCY_CODES: Record<number, string> = { 9: 'BRL', 7: 'USD' }

/** Valores monetários das APIs v3 vêm em micro-unidades inteiras (7810000 = 78,10). */
const MICRO_UNIT = 100000

/** Monta a URL pública de uma imagem a partir do hash da Shopee. */
function imageUrl(hash: string | null | undefined): string | null {
  if (!hash) return null
  if (hash.startsWith('http')) return hash
  return `https://down-br.img.susercontent.com/file/${hash}`
}

/**
 * Cliente das APIs internas do Seller Center.
 *
 * Esses endpoints não são públicos e podem mudar; por isso cada operação
 * tenta uma lista de candidatos e o parsing é tolerante a variações de
 * estrutura. O JSON bruto é sempre preservado no banco para diagnóstico.
 */

export interface NormalizedShopeeOrder {
  orderSn: string
  shopeeOrderId: string | null
  shopeeStatus: string | null
  buyerUsername: string | null
  buyerName: string | null
  totalAmount: number | null
  currency: string | null
  trackingNumber: string | null
  shipByDate: number | null
  createdAtShopee: number | null
  /** `order_ext_info.logistics_status`: 1 etiquetado · 9 aguardando · 2 enviado. */
  logisticsCode: number | null
  /** Texto da Shopee explicando o estado ("Pendente confirmação de postagem…"). */
  statusDescription: string | null
  paymentMethod: string | null
  /** Transportadora ("Shopee Xpress CPF"). */
  carrier: string | null
  /** Cidade/estado do comprador — o endereço completo vem mascarado. */
  shippingCity: string | null
  /** Caminho do pedido no Seller Center, para abrir direto lá. */
  shopeeUrlPath: string | null
  /** Código interno do pacote (OFG…), diferente do rastreio da transportadora. */
  packageNumber: string | null
  updatedAtShopee: number | null
  rawJson: string
  items: {
    itemName: string
    modelName: string | null
    quantity: number
    imageUrl: string | null
    itemSku: string | null
  }[]
}

async function getSpcCds(): Promise<string> {
  const ses = electronSession.fromPartition(SHOPEE_PARTITION)
  const cookies = await ses.cookies.get({ name: 'SPC_CDS' })
  return cookies[0]?.value ?? ''
}

// ---------- helpers de parsing tolerante ----------

type AnyObj = Record<string, unknown>

function isObj(v: unknown): v is AnyObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Procura recursivamente o primeiro array de objetos em que todo item satisfaz
 * o teste. Quanto mais específico o teste, menor a chance de casar um array
 * qualquer da resposta e produzir dados inventados.
 */
function findArrayWhere(
  root: unknown,
  match: (el: AnyObj) => boolean,
  depth = 0
): AnyObj[] | null {
  if (depth > 6) return null
  if (Array.isArray(root)) {
    if (root.length > 0 && root.every((el) => isObj(el) && match(el))) {
      return root as AnyObj[]
    }
    for (const el of root) {
      const found = findArrayWhere(el, match, depth + 1)
      if (found) return found
    }
    return null
  }
  if (isObj(root)) {
    for (const value of Object.values(root)) {
      const found = findArrayWhere(value, match, depth + 1)
      if (found) return found
    }
  }
  return null
}

/** Atalho: array em que todo item tem alguma das chaves. */
function findArrayWithKeys(root: unknown, keys: string[]): AnyObj[] | null {
  return findArrayWhere(root, (el) => keys.some((k) => k in el))
}

/**
 * Detecta "a lista existe e está vazia" (ex.: conversa sem mensagens), para
 * distinguir de "não entendi a resposta" — só o segundo caso justifica tentar
 * o próximo endpoint candidato.
 */
function hasEmptyListNamed(root: unknown, names: string[], depth = 0): boolean {
  if (depth > 6) return false
  if (Array.isArray(root)) {
    return root.some((el) => hasEmptyListNamed(el, names, depth + 1))
  }
  if (isObj(root)) {
    for (const [key, value] of Object.entries(root)) {
      if (Array.isArray(value) && value.length === 0 && names.includes(key)) return true
      if (hasEmptyListNamed(value, names, depth + 1)) return true
    }
  }
  return false
}

function pickString(obj: AnyObj, candidates: string[]): string | null {
  for (const key of candidates) {
    const v = deepGet(obj, key)
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number') return String(v)
  }
  return null
}

function pickNumber(obj: AnyObj, candidates: string[]): number | null {
  for (const key of candidates) {
    const v = deepGet(obj, key)
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v)
  }
  return null
}

/** Suporta caminho com pontos: "buyer_user.user_name". */
function deepGet(obj: AnyObj, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (!isObj(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

/**
 * Data do pedido a partir do próprio número.
 *
 * O card **não traz data de criação** (só `ship_by_date`), e sem ela a lista
 * não tinha como ser ordenada. O número do pedido começa com AAMMDD —
 * `260729W0DHMK58` = 29/07/2026 —, o que dá a data do dia sem custo nenhum.
 * É aproximada (não tem hora), e serve para ordenar, não para contabilidade.
 */
function dateFromOrderSn(orderSn: string): number | null {
  const match = /^(\d{2})(\d{2})(\d{2})/.exec(orderSn)
  if (!match) return null
  const [, aa, mm, dd] = match
  const year = 2000 + Number(aa)
  const month = Number(mm)
  const day = Number(dd)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return Date.UTC(year, month - 1, day)
}

/**
 * Cidade e estado a partir do endereço completo, que vem como uma string só:
 * "Rua Exemplo, 100, Apto 2, Cidade, Estado, 00000000".
 * Os dois campos antes do CEP são cidade e estado.
 */
function cityFromAddress(address: string | null): string | null {
  if (!address) return null
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 3) return null
  const semCep = parts[parts.length - 1].replace(/\D/g, '').length >= 8 ? parts.slice(0, -1) : parts
  const estado = semCep[semCep.length - 1]
  const cidade = semCep[semCep.length - 2]
  return cidade && estado ? `${cidade}/${estado}` : null
}

/**
 * A Shopee manda a explicação do estado como template não interpolado:
 * "envie o pedido antes de {timestamp} para evitar o cancelamento". O prazo é
 * o `ship_by_date`; sem ele, a frase pela metade confunde mais que ajuda e
 * some.
 */
function fillPlaceholders(text: string | null, shipByDate: number | null): string | null {
  if (!text) return null
  if (!text.includes('{')) return text
  if (shipByDate === null) return null
  return text.replace(
    /\{timestamp\}/g,
    new Date(shipByDate).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    })
  )
}

/** Timestamps da Shopee vêm em segundos; normaliza para ms. */
function toMs(ts: number | null): number | null {
  if (ts === null) return null
  return ts < 10_000_000_000 ? ts * 1000 : ts
}

/**
 * Normaliza um valor monetário. Inteiro = micro-unidades (7810000 → 78,10),
 * confirmado em `payment_info.total_price`; string com casa decimal ("78.10")
 * já vem pronta. Aplicado também ao financeiro — se o extrato usar outra
 * escala, é aqui que se corrige (o `raw_json` do evento mostra o valor cru).
 */
function toMoney(raw: unknown): number | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return null
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return null
    return trimmed.includes('.') || trimmed.includes(',') ? n : n / MICRO_UNIT
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Number.isInteger(raw) ? raw / MICRO_UNIT : raw
  }
  return null
}

function pickMoney(obj: AnyObj, candidates: string[]): number | null {
  for (const key of candidates) {
    const value = toMoney(deepGet(obj, key))
    if (value !== null) return value
  }
  return null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Repete a chamada em falhas transitórias (rede, 429, 5xx). Erro de negócio da
 * Shopee (código no corpo) e erro de sessão não se resolvem repetindo.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 700): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (err instanceof ShopeeApiError) {
        const transient = err.httpStatus === 0 || err.httpStatus === 429 || err.httpStatus >= 500
        if (!transient || err.isAuthError) throw err
      }
      if (attempt < attempts) await sleep(delayMs * attempt)
    }
  }
  throw lastError
}

interface Candidate {
  url: string
  init?: { method?: string; body?: unknown }
}

/**
 * Tenta uma lista de endpoints candidatos até um responder algo reconhecível.
 * `parse` devolve `null` quando a resposta não tem a cara esperada — só nesse
 * caso seguimos para o próximo. O erro final carrega o código/mensagem reais
 * de cada tentativa, que é o que permite calibrar os endpoints.
 */
async function tryCandidates<T>(
  what: string,
  candidates: Candidate[],
  parse: (json: unknown) => T[] | null
): Promise<T[]> {
  const failures: string[] = []
  let authError: ShopeeApiError | null = null

  for (const candidate of candidates) {
    const name = candidate.url.split('?')[0]
    try {
      const json = await withRetry(() => pageFetchJson(candidate.url, candidate.init))
      const parsed = parse(json)
      if (parsed === null) {
        failures.push(`${name}: respondeu, mas sem ${what} reconhecíveis`)
        continue
      }
      return parsed
    } catch (err) {
      if (err instanceof ShopeeApiError && err.isAuthError) authError = err
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (authError) {
    throw new Error(
      `Sessão da Shopee recusada ao buscar ${what}: ${authError.message}. ` +
        'Abra Configurações → Conectar e faça login de novo.'
    )
  }
  throw new Error(`Nenhum endpoint de ${what} funcionou. ${failures.join(' | ')}`)
}

// ---------- pedidos ----------

interface OrderIndexRef {
  order_id: number
  shop_id: number
  region_id: string
}

/**
 * Passo 1 — lista os pedidos (só IDs). Corresponde ao POST que a página
 * /portal/sale/order faz em search_order_list_index.
 */
async function fetchOrderIndex(cds: string, maxPages: number | null): Promise<OrderIndexRef[]> {
  const pageSize = 40
  const refs: OrderIndexRef[] = []
  // `null` = até acabar. O teto existe porque o índice é barato, mas cada
  // página vira 8 chamadas de card depois.
  const limit = maxPages ?? Number.MAX_SAFE_INTEGER
  for (let page = 1; page <= limit; page++) {
    if (page > 1) await sleep(200)
    const json = (await withRetry(() =>
      pageFetchJson(`/api/v3/order/search_order_list_index?SPC_CDS=${cds}&SPC_CDS_VER=2`, {
        method: 'POST',
        body: {
          order_list_tab: 100, // 100 = todos
          entity_type: 1,
          pagination: { from_page_number: 1, page_number: page, page_size: pageSize },
          filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 },
          sort: { sort_type: 3, ascending: false }
        }
      })
    )) as { data?: { index_list?: OrderIndexRef[] } }
    const list = json?.data?.index_list ?? []
    if (list.length === 0) break
    refs.push(...list)
    if (list.length < pageSize) break
  }
  return refs
}

/** Passo 2 — detalhes dos pedidos, em lotes, via get_order_list_card_list. */
async function fetchOrderCards(
  cds: string,
  refs: OrderIndexRef[],
  options: FetchOrdersOptions = { maxPages: 5 }
): Promise<AnyObj[]> {
  const cards: AnyObj[] = []
  // A Shopee limita o lote deste endpoint (erro 120410353 "too big").
  const batchSize = 5
  for (let i = 0; i < refs.length; i += batchSize) {
    const batch = refs.slice(i, i + batchSize)
    // Pausa entre lotes: são APIs internas, sem cota publicada — 200 pedidos já
    // seriam 40 chamadas seguidas.
    if (i > 0) await sleep(250)
    const json = (await withRetry(() =>
      pageFetchJson(`/api/v3/order/get_order_list_card_list?SPC_CDS=${cds}&SPC_CDS_VER=2`, {
        method: 'POST',
        body: {
          order_list_tab: 100,
          need_count_down_desc: true,
          order_param_list: batch.map((r) => ({
            order_id: r.order_id,
            shop_id: r.shop_id,
            region_id: r.region_id
          }))
        }
      })
    )) as { data?: { card_list?: AnyObj[] } }
    const lote = json?.data?.card_list ?? []
    cards.push(...lote)

    if (options.onCard) {
      for (let k = 0; k < lote.length; k++) {
        // O ref e o card vêm na mesma ordem; o id do ref é a chave do arquivo.
        const id = batch[k]?.order_id
        if (id !== undefined) await options.onCard(String(id), lote[k])
      }
    }
    options.onProgress?.(Math.min(i + batchSize, refs.length), refs.length)
  }
  return cards
}

function extractItems(groups: AnyObj[]): NormalizedShopeeOrder['items'] {
  const items: NormalizedShopeeOrder['items'] = []
  for (const group of groups) {
    const infoList = Array.isArray(group.item_info_list) ? (group.item_info_list as AnyObj[]) : []
    for (const info of infoList) {
      const itemList = Array.isArray(info.item_list) ? (info.item_list as AnyObj[]) : []
      for (const it of itemList) {
        const name = pickString(it, ['name'])
        if (!name) continue
        items.push({
          itemName: name,
          // "description" traz a variação, ex.: "Variação: 30 peças / 6 de cada modelo"
          modelName: pickString(it, ['description', 'model_name']),
          quantity: pickNumber(it, ['amount', 'quantity']) ?? 1,
          imageUrl: imageUrl(pickString(it, ['image'])),
          itemSku: pickString(it, ['inner_item_ext_info.item_id', 'item_sku'])
        })
      }
    }
  }
  return items
}

/**
 * Converte um card do get_order_list_card_list no formato interno.
 *
 * A Shopee usa duas formas: `order_card` (campos no topo) e
 * `package_level_order_card` (campos dentro de package_list[]). Esta função
 * normaliza as duas achatando para uma estrutura única.
 */
export function normalizeCard(card: AnyObj): NormalizedShopeeOrder | null {
  const inner = (card.order_card ?? card.package_level_order_card) as AnyObj | undefined
  if (!isObj(inner)) return null
  const header = (inner.card_header as AnyObj) ?? {}
  const orderSn = pickString(header, ['order_sn'])
  if (!orderSn) return null

  const ext = (inner.order_ext_info as AnyObj) ?? {}
  // No formato package_level o fulfilment_info fica dentro do pacote, não no
  // topo — ler só o topo fazia o rastreio cair no consignment_no e perder o
  // código real da transportadora (que é o que vai no QR da etiqueta).
  const fulfilment =
    (inner.fulfilment_info as AnyObj) ??
    ((inner.package_list as AnyObj[])?.[0]?.fulfilment_info as AnyObj) ??
    {}
  const packages = Array.isArray(inner.package_list) ? (inner.package_list as AnyObj[]) : []
  const firstPkg = packages[0] ?? {}

  // payment/status/itens ficam no topo (order_card) ou no 1º pacote (package_level).
  const payment = (inner.payment_info as AnyObj) ?? (firstPkg.payment_info as AnyObj) ?? {}
  const statusInfo = (inner.status_info as AnyObj) ?? (firstPkg.status_info as AnyObj) ?? {}

  const itemGroups: AnyObj[] = []
  if (isObj(inner.item_info_group)) itemGroups.push(inner.item_info_group as AnyObj)
  for (const pkg of packages) {
    if (isObj(pkg.item_info_group)) itemGroups.push(pkg.item_info_group as AnyObj)
  }
  const items = extractItems(itemGroups)

  // Rastreio: número real da transportadora, com fallbacks.
  const trackingList = fulfilment.tracking_number_list
  const pkgExtList = Array.isArray(inner.package_ext_info_list)
    ? (inner.package_ext_info_list as AnyObj[])
    : []
  const pkgExt = pkgExtList[0] ?? (firstPkg.package_ext_info as AnyObj) ?? {}
  const trackingNumber =
    (Array.isArray(trackingList) && typeof trackingList[0] === 'string' ? trackingList[0] : null) ??
    pickString(pkgExt, ['consignment_no', 'package_number'])

  const currencyNum = pickNumber(payment, ['currency'])

  return {
    orderSn,
    shopeeOrderId:
      pickNumber(ext, ['order_id']) !== null ? String(pickNumber(ext, ['order_id'])) : null,
    shopeeStatus: pickString(statusInfo, ['status']),
    buyerUsername: pickString(header, ['buyer_info.username']),
    // shipping_name vem mascarado ("V******s"); guardamos assim mesmo se existir.
    buyerName: pickString(pkgExt, ['shipping_name']),
    totalAmount: pickMoney(payment, ['total_price']),
    currency: currencyNum !== null ? (CURRENCY_CODES[currencyNum] ?? String(currencyNum)) : null,
    trackingNumber,
    shipByDate: toMs(pickNumber(ext, ['ship_by_date'])),
    logisticsCode: pickNumber(ext, ['logistics_status']),
    statusDescription: fillPlaceholders(
      pickString(statusInfo, ['status_description.description_value']),
      toMs(pickNumber(ext, ['ship_by_date']))
    ),
    paymentMethod: pickString(payment, ['payment_method']),
    carrier: pickString(fulfilment, ['fulfilment_channel_name']) ??
      pickString((firstPkg.fulfilment_info as AnyObj) ?? {}, ['fulfilment_channel_name']),
    // O endereço vem inteiro numa string; só a cidade/estado interessa aqui.
    shippingCity: cityFromAddress(pickString(pkgExt, ['shipping_address'])),
    shopeeUrlPath: pickString(ext, ['odp_url_path_query'])?.trim() ?? null,
    packageNumber: pickString(pkgExt, ['package_number']),
    createdAtShopee: toMs(pickNumber(ext, ['create_time', 'pay_time'])) ?? dateFromOrderSn(orderSn),
    updatedAtShopee: null,
    rawJson: JSON.stringify(card),
    items
  }
}

export interface FetchOrdersOptions {
  /** Páginas de 40 a buscar. `null` = todas, até a Shopee acabar. */
  maxPages: number | null
  /** Chamado a cada lote, para dar sinal de vida numa carga longa. */
  onProgress?: (done: number, total: number | null) => void
  /** Guarda o JSON cru de cada card (dump local para análise sem rede). */
  onCard?: (orderId: string, card: unknown) => Promise<void>
}

export async function fetchOrders(
  options: FetchOrdersOptions = { maxPages: 5 }
): Promise<NormalizedShopeeOrder[]> {
  const cds = await getSpcCds()
  const refs = await fetchOrderIndex(cds, options.maxPages)
  if (refs.length === 0) return []
  const cards = await fetchOrderCards(cds, refs, options)
  const orders: NormalizedShopeeOrder[] = []
  for (const card of cards) {
    const order = normalizeCard(card)
    if (order) orders.push(order)
  }
  return orders
}

/** Quantos pedidos a Shopee diz que existem (uma requisição, sem baixar nada). */
export async function fetchOrderTotal(): Promise<number | null> {
  const cds = await getSpcCds()
  const json = (await withRetry(() =>
    pageFetchJson(`/api/v3/order/search_order_list_index?SPC_CDS=${cds}&SPC_CDS_VER=2`, {
      method: 'POST',
      body: {
        order_list_tab: 100,
        entity_type: 1,
        pagination: { from_page_number: 1, page_number: 1, page_size: 1 },
        filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 },
        sort: { sort_type: 3, ascending: false }
      }
    })
  )) as { data?: { pagination?: { total?: number } } }
  return json?.data?.pagination?.total ?? null
}

// ---------- rastreio logístico ----------

export interface TrackingCheckpoint {
  description: string
  happenedAt: number
  rawJson: string
}

const CHECKPOINT_DESC_KEYS = ['description', 'message', 'text', 'status_description']
const CHECKPOINT_TIME_KEYS = ['timestamp', 'ctime', 'time', 'update_time', 'event_time']

export async function fetchTrackingInfo(
  orderSn: string,
  orderId: string | null
): Promise<TrackingCheckpoint[]> {
  // Confirmados por captura na página do pedido: ambos exigem order_id
  // numérico (order_sn não serve) e devolvem o histórico de checkpoints.
  if (!orderId) {
    throw new Error(
      `Pedido ${orderSn} sem order_id da Shopee — sincronize os pedidos antes de rastrear.`
    )
  }
  const cds = await getSpcCds()
  return tryCandidates<TrackingCheckpoint>(
    `rastreio de ${orderSn}`,
    [
      {
        url: `/api/v3/logistics/get_logistics_tracking_history?SPC_CDS=${cds}&SPC_CDS_VER=2&order_id=${orderId}`
      },
      {
        url: `/api/v3/order/get_order_tracking_history/?SPC_CDS=${cds}&SPC_CDS_VER=2&order_id=${orderId}`
      }
    ],
    (json) => {
      // Um checkpoint tem descrição E horário — exigir os dois evita casar
      // qualquer array de objetos que por acaso tenha "message".
      const arr = findArrayWhere(
        json,
        (el) =>
          CHECKPOINT_DESC_KEYS.some((k) => k in el) && CHECKPOINT_TIME_KEYS.some((k) => k in el)
      )
      if (!arr) {
        return hasEmptyListNamed(json, ['tracking_info', 'tracking_list', 'checkpoints', 'list'])
          ? []
          : null
      }
      const result: TrackingCheckpoint[] = []
      for (const c of arr) {
        const description = pickString(c, CHECKPOINT_DESC_KEYS)
        const happenedAt = toMs(pickNumber(c, CHECKPOINT_TIME_KEYS))
        if (!description || !happenedAt) continue
        result.push({ description, happenedAt, rawJson: JSON.stringify(c) })
      }
      return result.length > 0 ? result : null
    }
  )
}

// ---------- avaliações ----------

export interface ShopRating {
  orderSn: string
  star: number
  comment: string | null
  ratedAt: number | null
  rawJson: string
}

const RATING_STAR_KEYS = ['rating_star', 'star', 'rating']

export async function fetchRatings(pageSize = 50): Promise<ShopRating[]> {
  const cds = await getSpcCds()
  // Confirmado por captura na página de avaliações. O sufixo `_new/` e a barra
  // final importam: sem eles a Shopee responde 404.
  const query =
    `SPC_CDS=${cds}&SPC_CDS_VER=2&rating_star=5,4,3,2,1&page_number=1` +
    `&page_size=${pageSize}&cursor=0&from_page_number=1&language=pt-br`
  return tryCandidates<ShopRating>(
    'avaliações',
    [{ url: `/api/v3/settings/search_shop_rating_comments_new/?${query}` }],
    (json) => {
      // Nota + pedido: sem exigir os dois, qualquer lista com "rating" casa.
      const arr = findArrayWhere(
        json,
        (el) =>
          RATING_STAR_KEYS.some((k) => k in el) && ('order_sn' in el || 'ordersn' in el)
      )
      if (!arr) {
        return hasEmptyListNamed(json, ['list', 'rating_list', 'comment_list', 'items']) ? [] : null
      }
      const result: ShopRating[] = []
      for (const r of arr) {
        const orderSn = pickString(r, ['order_sn', 'ordersn'])
        const star = pickNumber(r, RATING_STAR_KEYS)
        if (!orderSn || star === null) continue
        result.push({
          orderSn,
          star,
          comment: pickString(r, ['comment', 'content', 'rating_comment']),
          ratedAt: toMs(pickNumber(r, ['ctime', 'create_time', 'rating_time', 'mtime'])),
          rawJson: JSON.stringify(r)
        })
      }
      return result.length > 0 ? result : null
    }
  )
}

// ---------- financeiro por pedido ----------

export interface OrderIncome {
  orderSn: string
  valorProdutos: number | null
  valorFrete: number | null
  descontoCupons: number | null
  taxaComissao: number | null
  taxaServico: number | null
  /** Taxas cobradas pela Shopee que não são comissão nem serviço. */
  outrasTaxas: number | null
  /** Líquido que cai na conta. */
  valorRecebido: number | null
  /** Quando o dinheiro **caiu**; null se ainda não caiu. */
  recebidoEm: number | null
  /** Data prevista de liberação, quando ainda está no futuro. */
  previstoPara: number | null
  rawJson: string
}

/**
 * Nomes dos campos do extrato da Shopee. Ficam **só aqui**: quem chama
 * `fetchOrderIncome` recebe os nossos (valorProdutos, taxaComissao…), então uma
 * renomeação do lado deles se resolve nesta tabela e em mais lugar nenhum.
 */
const CAMPOS_EXTRATO = {
  produtos: 'MERCHANDISE_SUBTOTAL',
  frete: 'SHIPPING_SUBTOTAL',
  cupons: 'REBATE_AND_VOUCHER',
  taxas: 'FEES_AND_CHARGES',
  comissao: 'COMMISSION_FEE',
  servico: 'SERVICE_FEE',
  total: /^(ESCROW_AMOUNT|TOTAL(_INCOME)?)$/i
}

/**
 * Extrato financeiro de UM pedido: quanto entrou, quando, e o que a Shopee
 * descontou no caminho.
 *
 * É por pedido e não há versão em lote conhecida — a página de finanças só
 * carrega a lista depois de o usuário filtrar, então quem chama decide quantos
 * consultar.
 */
export async function fetchOrderIncome(
  orderSn: string,
  orderId: string
): Promise<OrderIncome | null> {
  const cds = await getSpcCds()
  const json = (await withRetry(() =>
    pageFetchJson(
      `/api/v4/accounting/pc/seller_income/income_detail/get_order_income_components?SPC_CDS=${cds}&SPC_CDS_VER=2`,
      {
        method: 'POST',
        // components lista os blocos desejados; 1..6 traz extrato + info do pedido.
        body: { order_id: Number(orderId), components: [1, 2, 3, 4, 5, 6] }
      }
    )
  )) as { data?: AnyObj }
  return json?.data ? parseOrderIncome(json.data, orderSn) : null
}

/**
 * Lê o extrato já baixado. Separado do fetch para poder reprocessar o
 * `raw_json` guardado quando a leitura muda — foi assim que a confusão entre
 * data prevista e data efetiva se corrigiu sem rebuscar centenas de extratos.
 */
export function parseOrderIncome(data: AnyObj, orderSn: string): OrderIncome | null {
  if (!isObj(data) || !isObj(data.order_info)) return null

  const linhas = Array.isArray((data.seller_income_breakdown as AnyObj)?.breakdown)
    ? ((data.seller_income_breakdown as AnyObj).breakdown as AnyObj[])
    : []

  const valorDe = (nome: string, lista: AnyObj[] = linhas): number | null => {
    for (const linha of lista) {
      if (pickString(linha, ['field_name']) === nome) return toMoney(linha.amount)
    }
    return null
  }

  const subBloco = (nome: string): AnyObj[] => {
    for (const linha of linhas) {
      if (pickString(linha, ['field_name']) === nome && Array.isArray(linha.sub_breakdown)) {
        return linha.sub_breakdown as AnyObj[]
      }
    }
    return []
  }

  // ATENÇÃO: a lista traz as parcelas **e** o total (ESCROW_AMOUNT) como mais
  // uma linha; somar tudo conta o valor duas vezes.
  let total: number | null = null
  for (const linha of linhas) {
    if (CAMPOS_EXTRATO.total.test(pickString(linha, ['field_name']) ?? '')) {
      total = toMoney(linha.amount)
    }
  }

  const taxasSub = subBloco(CAMPOS_EXTRATO.taxas)
  const comissao = valorDe(CAMPOS_EXTRATO.comissao, taxasSub)
  const servico = valorDe(CAMPOS_EXTRATO.servico, taxasSub)
  const taxasTotal = valorDe(CAMPOS_EXTRATO.taxas)
  const outras =
    taxasTotal !== null ? Number((taxasTotal - (comissao ?? 0) - (servico ?? 0)).toFixed(2)) : null

  // ATENÇÃO: `released_time` guarda a data **prevista** enquanto o pagamento
  // não sai (o próprio `release_time_transify_key` fala em "estimate"), e a
  // prevista vem sempre 09:00 redondo. Tratar qualquer valor > 0 como pago
  // colocava pedido não pago na aba Concluído.
  const released = toMs(pickNumber(data.order_info as AnyObj, ['released_time']))
  const jaCaiu = released !== null && released > 0 && released <= Date.now()

  return {
    orderSn: pickString(data.order_info as AnyObj, ['order_sn']) ?? orderSn,
    valorProdutos: valorDe(CAMPOS_EXTRATO.produtos),
    valorFrete: valorDe(CAMPOS_EXTRATO.frete),
    descontoCupons: valorDe(CAMPOS_EXTRATO.cupons),
    taxaComissao: comissao,
    taxaServico: servico,
    outrasTaxas: outras === 0 ? null : outras,
    valorRecebido: total,
    recebidoEm: jaCaiu ? released : null,
    previstoPara: released !== null && released > 0 && !jaCaiu ? released : null,
    rawJson: JSON.stringify(data)
  }
}
