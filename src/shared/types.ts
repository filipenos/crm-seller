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
 * Fase do pedido, na ordem em que acontece. O status interno de produção só
 * vale em CONOSCO — a partir de POSTADO quem manda é o rastreio da Shopee.
 */
export const ORDER_PHASES = [
  'CONOSCO',
  'POSTADO',
  'COLETADO',
  'EM_TRANSITO',
  'SAIU_PARA_ENTREGA',
  'ENTREGUE',
  'PAGO',
  'CANCELADO'
] as const

export type OrderPhase = (typeof ORDER_PHASES)[number]

export const ORDER_PHASE_LABELS: Record<OrderPhase, string> = {
  CONOSCO: 'Conosco',
  POSTADO: 'No ponto de coleta',
  COLETADO: 'Coletado',
  EM_TRANSITO: 'Em trânsito',
  SAIU_PARA_ENTREGA: 'Saiu para entrega',
  ENTREGUE: 'Entregue — aguardando pagamento',
  PAGO: 'Pago',
  CANCELADO: 'Cancelado'
}

/** Fases em que o pedido ainda está com a gente e o status interno faz sentido. */
export function isWithUs(phase: OrderPhase): boolean {
  return phase === 'CONOSCO'
}

/**
 * Ações que uma etapa pode oferecer. O conjunto é fechado porque cada uma
 * dispara código do app; o que é cadastrável é *quais* aparecem em cada etapa,
 * com que rótulo e em que ordem.
 */
export const STAGE_ACTION_KINDS = [
  'CRIAR_PASTA',
  'ABRIR_PASTA',
  'GERAR_ETIQUETA',
  'ABRIR_MENSAGENS',
  'AVANCAR'
] as const

export type StageActionKind = (typeof STAGE_ACTION_KINDS)[number]

export const STAGE_ACTION_LABELS: Record<StageActionKind, string> = {
  CRIAR_PASTA: 'Criar pasta do pedido',
  ABRIR_PASTA: 'Abrir pasta do pedido',
  GERAR_ETIQUETA: 'Gerar etiqueta',
  ABRIR_MENSAGENS: 'Abrir conversa do comprador',
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
  /** Derivada do rastreio + pagamento; é ela que a UI usa para agrupar. */
  phase: OrderPhase
  /** Etapa de produção cadastrada. Só faz sentido enquanto a fase é CONOSCO. */
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
  /**
   * Sincronização automática. Desligada por padrão: são APIs internas da
   * Shopee, sem cota publicada — sincronizar sozinho a cada poucos minutos é
   * tráfego que ninguém pediu. Por padrão só o botão sincroniza.
   */
  autoSyncEnabled: boolean
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
  /** Fase logística; 'TODOS' não filtra. */
  phase?: OrderPhase | 'TODOS'
  /** Etapa de produção (só relevante em CONOSCO). */
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
