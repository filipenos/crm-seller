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
  labelPath: string | null
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
  unreadMessages: number
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

export interface Conversation {
  conversationId: string
  buyerUsername: string
  buyerAvatar: string | null
  lastMessageAt: number | null
  lastMessagePreview: string | null
  unreadCount: number
}

export interface ChatMessage {
  messageId: string
  conversationId: string
  orderSn: string | null
  direction: 'in' | 'out'
  contentType: string
  content: string
  imageUrl: string | null
  createdAt: number
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
  messagesUpserted: number
  eventsCreated: number
  error: string | null
}

export interface OrderFilters {
  internalStatus?: InternalStatus | 'TODOS'
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
