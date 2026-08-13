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

/** Extrato financeiro do pedido, com as taxas separadas. */
export interface Recebimento {
  valorProdutos: number | null
  valorFrete: number | null
  descontoCupons: number | null
  taxaComissao: number | null
  taxaServico: number | null
  outrasTaxas: number | null
  /** Comissão + serviço + outras, em valor absoluto. */
  totalTaxas: number | null
  valorRecebido: number | null
  /** Quando o dinheiro caiu de fato. */
  recebidoEm: number | null
  /** Previsão de liberação, quando ainda não caiu. */
  previstoPara: number | null
}

export interface OrderItem {
  id: number
  orderSn: string
  itemName: string
  modelName: string | null
  quantity: number
  /** Caixas do kit, lidas da variação ("20 peças"). */
  pecas: number | null
  imageUrl: string | null
  itemSku: string | null
}

export interface Order {
  orderSn: string
  shopeeOrderId: string | null
  shopeeStatus: string | null
  /** Aba a que o pedido pertence, igual ao Seller Center. */
  tab: OrderTab
  /** Etiqueta já gerada: o pedido pode ir ao ponto de coleta. */
  readyToPost: boolean
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
  /** Null enquanto o extrato daquele pedido não foi buscado. */
  recebimento: Recebimento | null
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
  /**
   * Etapas que o botão Sincronizar executa depois de trazer os pedidos.
   * Ligadas por padrão; desligar serve para uma sincronização rápida, só dos
   * pedidos novos, sem as chamadas por pedido que levam minutos.
   */
  syncTracking: boolean
  syncPayments: boolean
  syncIntervalMinutes: number
  shopeeBaseDomain: string
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

/** Progresso de uma operação longa (rastreios, extratos). */
export type EtapaSync = 'pedidos' | 'rastreios' | 'pagamentos'

export interface ProgressoLote {
  rodando: boolean
  feitos: number
  total: number
  /** Etapa em curso, para a barra dizer o que está acontecendo. */
  rotulo: EtapaSync | ''
}

export interface ResultadoLote {
  feitos: number
  cancelado: boolean
  erros: number
}

/** Números de um período, para o painel. */
export interface ResumoPeriodo {
  pedidos: number
  /** Soma do que os clientes pagaram nos pedidos que entraram no período. */
  vendas: number
  /** Caixas vendidas: o kit diz quantas peças tem. */
  caixas: number
  /** Dinheiro que caiu na conta no período (data real de liberação). */
  recebido: number
  pedidosRecebidos: number
  /** Pedidos deixados no ponto de coleta no período. */
  despachados: number
}

export const METRICAS_PAINEL = ['pedidos', 'caixas', 'vendas', 'recebido', 'despachados'] as const
export type MetricaPainel = (typeof METRICAS_PAINEL)[number]

export const METRICA_LABELS: Record<MetricaPainel, string> = {
  pedidos: 'Pedidos',
  caixas: 'Caixas vendidas',
  vendas: 'Vendas',
  recebido: 'Recebido',
  despachados: 'Despachados'
}

/** Métricas em dinheiro, para formatar como moeda. */
export const METRICAS_EM_REAIS: MetricaPainel[] = ['vendas', 'recebido']

export interface SerieMensal {
  metrica: MetricaPainel
  ano: number
  /** 1-12. */
  mes: number
  dias: { dia: number; valor: number }[]
  total: number
}

export interface Painel {
  hoje: ResumoPeriodo
  ultimos7: ResumoPeriodo
  ultimos30: ResumoPeriodo
  aEnviar: number
  prontosParaPostar: number
  emTransito: number
  /** Valor já calculado pela Shopee que ainda não caiu. */
  aReceber: number
  pedidosAReceber: number
  /** Pedidos com menos de 24h para postar. */
  prazoApertado: number
}

export interface OrderCounts {
  tabs: TabCounts
  /** Dentro de A enviar, quantos já têm etiqueta gerada. */
  readyToPost: number
  /** Pedidos concluídos cujo extrato ainda não foi buscado. */
  semExtrato: number
}

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
