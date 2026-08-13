import type { OrderTab } from '@shared/types'

/**
 * Em que aba do Seller Center o pedido está.
 *
 * O status do card sozinho não decide: "Entregue" e "Pedido Recebido" caem em
 * **Enviado** enquanto o dinheiro não sai, e em **Concluído** depois que sai.
 * Foi assim que os 550/19 da conta real fecharam — 541 com status "Concluído"
 * mais 9 entregues já pagos de um lado, 19 entregues sem pagamento do outro.
 *
 * Consequência prática: para os pedidos entre postagem e pagamento, a aba só
 * é exata depois de consultar o extrato daquele pedido. Enquanto não consultou,
 * ele aparece em Enviado, que é o palpite certo na dúvida (a Shopee leva dias
 * para liberar).
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
const A_ENVIAR = /a enviar|to ship|pendente de envio/i
const CONCLUIDO = /conclu[íi]|completed/i

export function deriveTab(input: {
  shopeeStatus: string | null
  escrowReleasedAt: number | null
}): OrderTab {
  const status = input.shopeeStatus ?? ''
  if (CANCELADO.test(status)) return 'CANCELADO'
  if (A_ENVIAR.test(status)) return 'A_ENVIAR'
  if (CONCLUIDO.test(status)) return 'CONCLUIDO'
  // Enviado / Entregue / Pedido Recebido: o pagamento é o desempate.
  return input.escrowReleasedAt !== null ? 'CONCLUIDO' : 'ENVIADO'
}
