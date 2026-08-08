// Tipos compartilhados entre main, preload e renderer.

export const INTERNAL_STATUSES = [
  'NOVO',
  'AGUARDANDO_INFO',
  'CRIAR_ARQUIVOS',
  'PRONTO_PARA_IMPRIMIR',
  'IMPRESSO',
  'EMBALADO',
  'ENVIADO',
  'CONCLUIDO',
  'CANCELADO'
] as const

export type InternalStatus = (typeof INTERNAL_STATUSES)[number]

export const INTERNAL_STATUS_LABELS: Record<InternalStatus, string> = {
  NOVO: 'Novo',
  AGUARDANDO_INFO: 'Aguardando info',
  CRIAR_ARQUIVOS: 'Criar arquivos',
  PRONTO_PARA_IMPRIMIR: 'Pronto p/ imprimir',
  IMPRESSO: 'Impresso',
  EMBALADO: 'Embalado',
  ENVIADO: 'Enviado',
  CONCLUIDO: 'Concluído',
  CANCELADO: 'Cancelado'
}

/**
 * Aba do pedido, espelhando o Seller Center — foi a agrupação validada contra
 * a conta real (550 concluídos / 19 enviados / 26 a enviar / 85 cancelados).
 *
 * Cuidado: o status do card **não** determina a aba sozinho. `Entregue` e
 * `Pedido Recebido` aparecem tanto em Enviado quanto em Concluído; quem
 * desempata é a liberação do pagamento.
 */
export const ORDER_TABS = ['A_ENVIAR', 'ENVIADO', 'CONCLUIDO', 'CANCELADO'] as const

export type OrderTab = (typeof ORDER_TABS)[number]

export const ORDER_TAB_LABELS: Record<OrderTab, string> = {
  A_ENVIAR: 'A enviar',
  ENVIADO: 'Enviado',
  CONCLUIDO: 'Concluído',
  CANCELADO: 'Cancelado'
}

/** Abas mostradas na listagem principal; cancelados ficam em página própria. */
export const MAIN_TABS: OrderTab[] = ['A_ENVIAR', 'ENVIADO', 'CONCLUIDO']

/** O pedido ainda está conosco: é só aqui que a etapa de produção vale. */
export function isWithUs(tab: OrderTab): boolean {
  return tab === 'A_ENVIAR'
}

/**
 * Progresso de envio, do próprio card (`order_ext_info.logistics_status`).
 * Confirmado comparando os pedidos etiquetados com os demais.
 */
export const LOGISTICS_READY_TO_POST = 1
export const LOGISTICS_WAITING = 9

/**
 * Ações que uma etapa pode oferecer. O conjunto é fechado porque cada uma
 * dispara código do app; o que é cadastrável é *quais* aparecem em cada etapa,
 * com que rótulo e em que ordem.
 */
export const STAGE_ACTION_KINDS = ['CRIAR_PASTA', 'ABRIR_PASTA', 'AVANCAR'] as const

export type StageActionKind = (typeof STAGE_ACTION_KINDS)[number]

export const STAGE_ACTION_LABELS: Record<StageActionKind, string> = {
  CRIAR_PASTA: 'Criar pasta do pedido',
  ABRIR_PASTA: 'Abrir pasta do pedido',
  AVANCAR: 'Avançar para a próxima etapa'
}

export interface StageAction {
  id: number
  stageId: number
  label: string
  kind: StageActionKind
  position: number
}

export interface WorkflowStage {
  id: number
  name: string
  position: number
  color: string | null
  actions: StageAction[]
}

export interface OrderItem {
  id: number
  orderSn: string
  itemName: string
  modelName: string | null
  quantity: number
  imageUrl: string | null
  itemSku: string | null
}

export interface Order {
  orderSn: string
  shopeeOrderId: string | null
  shopeeStatus: string | null
  /** Aba a que o pedido pertence, igual ao Seller Center. */
  tab: OrderTab
  /** Código de progresso de envio do card; separa etiquetado de aguardando. */
  logisticsCode: number | null
  /** Explicação da Shopee para o estado atual. */
  statusDescription: string | null
  paymentMethod: string | null
  carrier: string | null
  shippingCity: string | null
  shopeeUrlPath: string | null
  /** Código interno do pacote (OFG…); o QR da etiqueta pode trazer este ou o da transportadora. */
  packageNumber: string | null
  /** Etapa de produção cadastrada. Só faz sentido enquanto está conosco. */
  stageId: number | null
  stageName: string | null
  stageColor: string | null
  internalStatus: InternalStatus
  buyerUsername: string | null
  buyerName: string | null
  totalAmount: number | null
  currency: string | null
  childName: string | null
  note: string | null
  trackingNumber: string | null
  shipByDate: number | null
  folderPath: string | null
  createdAtShopee: number | null
  updatedAtShopee: number | null
  syncedAt: number | null
  logisticsStatus: string | null
  deliveredAt: number | null
  ratingStar: number | null
  ratingComment: string | null
  ratedAt: number | null
  escrowAmount: number | null
  escrowReleasedAt: number | null
  items: OrderItem[]
}

export type OrderEventSource = 'logistics' | 'rating' | 'finance' | 'status'

export interface OrderEvent {
  eventKey: string
  orderSn: string
  source: OrderEventSource
  description: string
  happenedAt: number
  createdAt: number
  seen: boolean
}

export interface StatusHistoryEntry {
  id: number
  orderSn: string
  fromStatus: string | null
  toStatus: string
  changedAt: number
}

export interface AppSettings {
  ordersRootDir: string
  templatesDir: string
  /**
   * Sincronização automática. Desligada por padrão: são APIs internas da
   * Shopee, sem cota publicada — sincronizar sozinho a cada poucos minutos é
   * tráfego que ninguém pediu. Por padrão só o botão sincroniza.
   */
  autoSyncEnabled: boolean
  /**
   * Páginas de 40 pedidos que o botão Sincronizar busca. O padrão cobre os
   * mais recentes, que é o que muda no dia a dia; a base inteira sai pelo
   * "Sincronizar tudo".
   */
  syncPageCount: number
  syncIntervalMinutes: number
  shopeeBaseDomain: string
  /**
   * Override opcional do repositório de atualizações ("dono/repo"). Vazio =
   * usa o repositório gravado no instalador, que é o normal.
   */
  githubRepo: string
}

export type UpdateState =
  /** Rodando em desenvolvimento: só o app instalado se atualiza. */
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'downloading'
  /** Baixada e pronta: instala ao fechar o app, ou agora se o usuário mandar. */
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  latestVersion: string | null
  /** 0–100 durante o download. */
  percent: number | null
  error: string | null
  checkedAt: number | null
}

export interface ShopeeConnectionStatus {
  connected: boolean
  shopName: string | null
  lastSyncAt: number | null
  lastSyncError: string | null
  syncing: boolean
}

export interface SyncResult {
  ok: boolean
  ordersUpserted: number
  newOrders: number
  eventsCreated: number
  error: string | null
}

export type TabCounts = Record<OrderTab, number>

export interface OrderFilters {
  internalStatus?: InternalStatus | 'TODOS'
  /** Aba; 'TODOS' não filtra (e nunca inclui cancelados, que têm página própria). */
  tab?: OrderTab | 'TODOS'
  /** Só os prontos para postar (etiqueta gerada). */
  readyToPost?: boolean
  /** Etapa de produção (só relevante em A_ENVIAR). */
  stageId?: number
  search?: string
  /** Só pedidos entregues cujo pagamento ainda não foi liberado. */
  awaitingPayment?: boolean
}

export interface ActionResult {
  ok: boolean
  error?: string
  path?: string
}

export interface TrackingRefreshResult {
  ok: boolean
  newEvents: number
  latestStatus: string | null
  error: string | null
}
