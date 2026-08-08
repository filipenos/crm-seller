import { session as electronSession } from 'electron'
import { pageFetchJson, pageFetchBinary, ShopeeApiError, SHOPEE_PARTITION } from './session'

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

export interface NormalizedConversation {
  conversationId: string
  buyerUsername: string
  buyerAvatar: string | null
  lastMessageAt: number | null
  lastMessagePreview: string | null
  unreadCount: number
  rawJson: string
}

export interface NormalizedMessage {
  messageId: string
  conversationId: string
  orderSn: string | null
  direction: 'in' | 'out'
  contentType: string
  content: string
  imageUrl: string | null
  createdAt: number
  rawJson: string
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
async function fetchOrderIndex(cds: string, maxPages: number): Promise<OrderIndexRef[]> {
  const pageSize = 40
  const refs: OrderIndexRef[] = []
  for (let page = 1; page <= maxPages; page++) {
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
async function fetchOrderCards(cds: string, refs: OrderIndexRef[]): Promise<AnyObj[]> {
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
    cards.push(...(json?.data?.card_list ?? []))
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
function normalizeCard(card: AnyObj): NormalizedShopeeOrder | null {
  const inner = (card.order_card ?? card.package_level_order_card) as AnyObj | undefined
  if (!isObj(inner)) return null
  const header = (inner.card_header as AnyObj) ?? {}
  const orderSn = pickString(header, ['order_sn'])
  if (!orderSn) return null

  const ext = (inner.order_ext_info as AnyObj) ?? {}
  const fulfilment = (inner.fulfilment_info as AnyObj) ?? {}
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
    createdAtShopee: toMs(pickNumber(ext, ['create_time', 'pay_time'])),
    updatedAtShopee: null,
    rawJson: JSON.stringify(card),
    items
  }
}

export async function fetchOrders(maxPages = 5): Promise<NormalizedShopeeOrder[]> {
  const cds = await getSpcCds()
  const refs = await fetchOrderIndex(cds, maxPages)
  if (refs.length === 0) return []
  const cards = await fetchOrderCards(cds, refs)
  return cards.map(normalizeCard).filter((o): o is NormalizedShopeeOrder => o !== null)
}

// ---------- chat ----------

export async function fetchConversations(limit = 60): Promise<NormalizedConversation[]> {
  return tryCandidates<NormalizedConversation>(
    'conversas',
    [
      { url: `/webchat/api/v1.2/conversations?offset=0&limit=${limit}` },
      { url: `/webchat/api/v1/conversations?offset=0&limit=${limit}` },
      { url: `/webchat/api/coreapi/conversations?offset=0&limit=${limit}` }
    ],
    (json) => {
      const arr = findArrayWhere(
        json,
        (el) => 'conversation_id' in el || 'to_id' in el || 'to_name' in el
      )
      if (!arr) {
        return hasEmptyListNamed(json, ['conversations', 'conversation_list', 'list', 'data'])
          ? []
          : null
      }
      const result: NormalizedConversation[] = []
      for (const c of arr) {
        const conversationId = pickString(c, ['conversation_id', 'id'])
        const buyerUsername = pickString(c, ['to_name', 'username', 'to_username', 'user_name'])
        if (!conversationId || !buyerUsername) continue
        result.push({
          conversationId,
          buyerUsername,
          buyerAvatar: pickString(c, ['to_avatar', 'avatar', 'portrait']),
          lastMessageAt: toMs(
            pickNumber(c, ['last_message_time', 'last_message.timestamp', 'latest_message_time'])
          ),
          lastMessagePreview: pickString(c, [
            'last_message_content',
            'last_message.content.text',
            'latest_message_content'
          ]),
          unreadCount: pickNumber(c, ['unread_count']) ?? 0,
          rawJson: JSON.stringify(c)
        })
      }
      // Array casado mas nada aproveitável = casamos o array errado.
      return result.length > 0 ? result : null
    }
  )
}

export async function fetchMessages(
  conversationId: string,
  limit = 60
): Promise<NormalizedMessage[]> {
  return tryCandidates<NormalizedMessage>(
    'mensagens',
    [
      { url: `/webchat/api/v1.2/conversations/${conversationId}/messages?limit=${limit}` },
      { url: `/webchat/api/v1/conversations/${conversationId}/messages?limit=${limit}` },
      { url: `/webchat/api/coreapi/conversations/${conversationId}/messages?limit=${limit}` }
    ],
    (json) => {
      const arr = findArrayWithKeys(json, ['message_id', 'msg_id'])
      if (!arr) {
        // Conversa sem mensagens é resposta válida — não é motivo para tentar outro endpoint.
        return hasEmptyListNamed(json, ['messages', 'message_list', 'msg_list', 'list', 'data'])
          ? []
          : null
      }
      const result: NormalizedMessage[] = []
      for (const m of arr) {
        const messageId = pickString(m, ['message_id', 'msg_id', 'id'])
        if (!messageId) continue
        const fromShop =
          pickNumber(m, ['from_shop', 'is_self', 'from_self']) === 1 ||
          deepGet(m, 'from_shop') === true ||
          deepGet(m, 'is_self') === true
        const contentType = pickString(m, ['type', 'message_type', 'content_type']) ?? 'text'
        result.push({
          messageId,
          conversationId,
          orderSn: pickString(m, ['order_sn', 'content.order_sn', 'ordersn']),
          direction: fromShop ? 'out' : 'in',
          contentType,
          content:
            pickString(m, ['content.text', 'text', 'content', 'message']) ??
            (contentType !== 'text' ? `[${contentType}]` : ''),
          imageUrl: pickString(m, [
            'content.image_url',
            'content.url',
            'image_url',
            'content.thumb_url'
          ]),
          createdAt:
            toMs(pickNumber(m, ['timestamp', 'create_time', 'created_at', 'time'])) ?? Date.now(),
          rawJson: JSON.stringify(m)
        })
      }
      return result.length > 0 ? result : null
    }
  )
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
  /** Quanto sobra para o vendedor, já com cupons, frete e taxas. */
  sellerIncome: number | null
  /** Quando o dinheiro foi liberado; null enquanto a Shopee ainda segura. */
  releasedAt: number | null
  /** Linhas do extrato (positivas e negativas) para futura análise de margem. */
  breakdown: { name: string; label: string; amount: number }[]
  rawJson: string
}

/**
 * Extrato financeiro de UM pedido.
 *
 * Substitui a tentativa antiga de ler a carteira inteira (`/api/v3/finance/*`,
 * que responde 404): este é o endpoint que a página de receitas realmente usa.
 * Traz, além da liberação do pagamento, a composição completa — preço, cupom,
 * frete e taxas —, que é a base para calcular margem por pedido.
 *
 * É por pedido, então o chamador decide quantos consultar: não existe versão
 * em lote conhecida.
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
  )) as {
    data?: {
      order_info?: { order_sn?: string; released_time?: number }
      seller_income_breakdown?: { breakdown?: AnyObj[] }
    }
  }

  const data = json?.data
  if (!isObj(data) || !isObj(data.order_info)) return null

  const lines = Array.isArray(data.seller_income_breakdown?.breakdown)
    ? (data.seller_income_breakdown.breakdown as AnyObj[])
    : []

  // ATENÇÃO: a lista traz as parcelas **e** o total (ESCROW_AMOUNT) como mais
  // uma linha. Somar tudo dá o dobro — o total sai daqui, não de uma soma.
  const TOTAL_FIELD = /^(ESCROW_AMOUNT|TOTAL(_INCOME)?)$/i

  const breakdown: OrderIncome['breakdown'] = []
  let total: number | null = null
  for (const line of lines) {
    const amount = toMoney(line.amount)
    if (amount === null) continue
    const name = pickString(line, ['field_name']) ?? 'DESCONHECIDO'
    if (TOTAL_FIELD.test(name)) {
      total = amount
      continue
    }
    breakdown.push({ name, label: pickString(line, ['display_name']) ?? '', amount })
  }

  // Sem a linha de total, as parcelas somam o mesmo valor (os sub_breakdown
  // compõem o item pai, então só o nível de cima entra na conta).
  const sellerIncome =
    total ?? (breakdown.length > 0 ? breakdown.reduce((soma, l) => soma + l.amount, 0) : null)

  // released_time 0 = ainda não liberado (a Shopee não usa null aqui).
  const released = pickNumber(data.order_info as AnyObj, ['released_time'])
  const releasedAt = released && released > 0 ? toMs(released) : null

  return {
    orderSn: pickString(data.order_info as AnyObj, ['order_sn']) ?? orderSn,
    sellerIncome,
    releasedAt,
    breakdown,
    rawJson: JSON.stringify(data)
  }
}

// ---------- etiqueta / documento de envio ----------

export async function downloadShippingDocument(orderSn: string, orderId: string | null): Promise<Buffer> {
  const cds = await getSpcCds()
  const attempts: { url: string; init?: { method?: string; body?: unknown } }[] = [
    {
      url: `/api/v3/logistics/download_shipping_document?SPC_CDS=${cds}&SPC_CDS_VER=2`,
      init: {
        method: 'POST',
        body: { order_list: [{ order_sn: orderSn, ...(orderId ? { order_id: Number(orderId) } : {}) }] }
      }
    },
    {
      url: `/api/v3/logistics/get_shipping_document?SPC_CDS=${cds}&SPC_CDS_VER=2&order_sn=${orderSn}`
    }
  ]
  const errors: string[] = []
  for (const attempt of attempts) {
    try {
      const buf = await pageFetchBinary(attempt.url, attempt.init)
      // Valida que parece um PDF (evita salvar página de erro em HTML).
      if (buf.subarray(0, 4).toString('latin1') === '%PDF') return buf
      errors.push(`${attempt.url.split('?')[0]}: resposta não é PDF`)
    } catch (err) {
      errors.push(String(err))
    }
  }
  throw new Error(`Não foi possível baixar a etiqueta da Shopee. ${errors.join(' | ')}`)
}
