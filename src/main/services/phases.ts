import type { OrderPhase } from '@shared/types'
import { ORDER_PHASES } from '@shared/types'

/**
 * Tradução dos checkpoints do rastreio da Shopee para a fase do pedido.
 *
 * Os textos vêm em português e livres (a Shopee muda a redação sem aviso), por
 * isso o casamento é por padrão e não por igualdade. Amostra real de um pedido
 * entregue, que serviu de base:
 *
 *   Pedido em preparação                        → CONOSCO
 *   Pedido postado Mogi das Cruzes - SP         → POSTADO
 *   Seu pedido foi coletado                     → COLETADO
 *   chegou ao centro logístico: Guarulhos - SP  → EM_TRANSITO
 *   Pedido em rota de entrega para seu endereço → SAIU_PARA_ENTREGA
 *   Pedido entregue ao destinatário             → ENTREGUE
 *
 * A ordem importa: do mais avançado para o menos, porque "entregue ao
 * destinatário" também casaria com padrões mais fracos.
 */
const CHECKPOINT_PHASES: { phase: OrderPhase; pattern: RegExp }[] = [
  { phase: 'ENTREGUE', pattern: /entregue ao destinat|entrega realizada|foi entregue|delivered/i },
  { phase: 'SAIU_PARA_ENTREGA', pattern: /rota de entrega|saiu para entrega|out for delivery/i },
  {
    phase: 'EM_TRANSITO',
    pattern: /centro log[íi]stico|em tr[âa]nsito|transfer[êe]ncia|a caminho|in transit/i
  },
  { phase: 'COLETADO', pattern: /coletado|coleta realizada|picked up/i },
  // "postado" é o momento em que largamos o pacote no ponto de coleta.
  { phase: 'POSTADO', pattern: /postado|ponto de coleta|dropped off|posted/i },
  { phase: 'CONOSCO', pattern: /em prepara[çc][ãa]o|aguardando envio|pending/i }
]

/** Fase que um checkpoint isolado indica, ou null se não reconhecido. */
export function phaseFromCheckpoint(description: string): OrderPhase | null {
  for (const { phase, pattern } of CHECKPOINT_PHASES) {
    if (pattern.test(description)) return phase
  }
  return null
}

function rank(phase: OrderPhase): number {
  return ORDER_PHASES.indexOf(phase)
}

/**
 * Fase mais avançada entre os checkpoints. Usa o máximo, não o último: os
 * checkpoints nem sempre chegam em ordem, e voltar de fase confundiria mais do
 * que ajudaria.
 */
export function phaseFromCheckpoints(descriptions: string[]): OrderPhase | null {
  let best: OrderPhase | null = null
  for (const description of descriptions) {
    const phase = phaseFromCheckpoint(description)
    if (phase && (best === null || rank(phase) > rank(best))) best = phase
  }
  return best
}

/** Palavras de cancelamento no status que a Shopee dá ao pedido. */
const CANCELLED = /cancelad|cancelled|devolvid|returned/i

/**
 * Fase aproximada a partir do status do pedido (o rótulo do card), usada
 * enquanto ninguém pediu o rastreio daquele pedido.
 *
 * Vale porque o status já vem na sincronização: sem isso, os pedidos antigos
 * ficariam todos como "conosco" até alguém puxar o rastreio um a um — 233
 * requisições para descobrir o que o próprio card já diz. O rastreio, quando
 * vier, é mais específico e prevalece.
 */
function phaseFromOrderStatus(status: string | null): OrderPhase | null {
  if (!status) return null
  if (/conclu[íi]|entregue|completed|delivered/i.test(status)) return 'ENTREGUE'
  if (/enviado|shipped|em tr[âa]nsito|a caminho/i.test(status)) return 'EM_TRANSITO'
  if (/a enviar|recebido|to ship|pending|processando/i.test(status)) return 'CONOSCO'
  return null
}

/**
 * Fase final do pedido. Cancelamento e pagamento passam por cima do rastreio:
 * um pedido pago já cumpriu todo o caminho, e um cancelado saiu do fluxo.
 */
export function derivePhase(input: {
  shopeeStatus: string | null
  logisticsPhase: string | null
  escrowReleasedAt: number | null
}): OrderPhase {
  if (input.shopeeStatus && CANCELLED.test(input.shopeeStatus)) return 'CANCELADO'
  if (input.escrowReleasedAt !== null) return 'PAGO'

  const fromTracking = input.logisticsPhase as OrderPhase | null
  const tracked =
    fromTracking && (ORDER_PHASES as readonly string[]).includes(fromTracking) ? fromTracking : null
  const fromStatus = phaseFromOrderStatus(input.shopeeStatus)

  // Fica com a mais avançada das duas: o rastreio é mais detalhado, mas o
  // status do card às vezes está à frente (rastreio nunca pedido).
  if (tracked && fromStatus) {
    return ORDER_PHASES.indexOf(tracked) >= ORDER_PHASES.indexOf(fromStatus) ? tracked : fromStatus
  }
  return tracked ?? fromStatus ?? 'CONOSCO'
}
