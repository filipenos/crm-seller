import type { OrderTab } from '@shared/types'

/**
 * Em que aba do Seller Center o pedido está.
 *
 * Esta função é fallback para dados históricos sem a aba de origem. A sync
 * normal usa a aba real da Shopee para A Enviar e Enviado.
 */

/**
 * Código de progresso de envio da Shopee (`order_ext_info.logistics_status`).
 * Fica aqui e não nos tipos compartilhados: é vocabulário deles, e a UI não
 * deve conhecer número de terceiro — ela recebe `readyToPost`.
 */
export const LOGISTICS_READY_TO_POST = 1

/** Traduz o código de envio para o nosso conceito. */
export function isReadyToPost(logisticsCode: number | null): boolean {
  return logisticsCode === LOGISTICS_READY_TO_POST
}

const CANCELADO = /cancelad|cancelled|devolvid|returned/i
const NAO_PAGO = /n[aã]o pago|unpaid/i
const A_ENVIAR = /a enviar|to ship|pendente de envio/i
const CONCLUIDO = /conclu[íi]|completed/i

export function deriveTab(input: {
  shopeeStatus: string | null
  escrowReleasedAt: number | null
}): OrderTab {
  const status = input.shopeeStatus ?? ''
  if (CANCELADO.test(status)) return 'CANCELADO'
  if (NAO_PAGO.test(status)) return 'NAO_PAGO'
  if (A_ENVIAR.test(status)) return 'A_ENVIAR'
  if (CONCLUIDO.test(status)) return 'CONCLUIDO'
  // Enviado / Entregue / Pedido Recebido: o pagamento é o desempate.
  return input.escrowReleasedAt !== null ? 'CONCLUIDO' : 'ENVIADO'
}

/** A aba ativa da Shopee prevalece sobre o texto do card, que pode estar defasado. */
export function tabFromShopeeSource(
  status: string | null,
  activeTab: 'A_ENVIAR' | 'ENVIADO' | null
): OrderTab | null {
  if (activeTab) return activeTab
  if (CANCELADO.test(status ?? '')) return 'CANCELADO'
  if (NAO_PAGO.test(status ?? '')) return 'NAO_PAGO'
  if (/^(delivered|order received|entregue|pedido recebido)$/i.test(status ?? '')) {
    return 'CONCLUIDO'
  }
  return null
}
