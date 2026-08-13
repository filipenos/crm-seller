import { getDb } from '../db'
import type { OrderIncome as ExtratoShopee } from './shopee/client'
import { parseOrderIncome } from './shopee/client'
import type { Recebimento } from '@shared/types'
import { recomputeDerived } from './orders'

/**
 * Recebimentos: quanto entrou por pedido e o que a Shopee descontou.
 *
 * O extrato é consultado **um pedido por vez** (não há endpoint de lista), e
 * pedido concluído nunca muda de valor — então isto é escrito uma vez e serve
 * para sempre. Por isso os fluxos de busca perguntam antes quem ainda não tem.
 */

interface RecebimentoRow {
  order_sn: string
  valor_produtos: number | null
  valor_frete: number | null
  desconto_cupons: number | null
  taxa_comissao: number | null
  taxa_servico: number | null
  outras_taxas: number | null
  valor_recebido: number | null
  recebido_em: number | null
  previsto_para: number | null
}

export function rowToRecebimento(row: RecebimentoRow): Recebimento {
  const taxas =
    (row.taxa_comissao ?? 0) + (row.taxa_servico ?? 0) + (row.outras_taxas ?? 0)
  return {
    valorProdutos: row.valor_produtos,
    valorFrete: row.valor_frete,
    descontoCupons: row.desconto_cupons,
    taxaComissao: row.taxa_comissao,
    taxaServico: row.taxa_servico,
    outrasTaxas: row.outras_taxas,
    // As taxas vêm negativas no extrato; para exibir, o que importa é o quanto.
    totalTaxas: taxas === 0 ? null : Math.abs(Number(taxas.toFixed(2))),
    valorRecebido: row.valor_recebido,
    recebidoEm: row.recebido_em,
    previstoPara: row.previsto_para
  }
}

export function salvarRecebimento(extrato: ExtratoShopee): void {
  getDb()
    .prepare(
      `INSERT INTO order_income (
         order_sn, valor_produtos, valor_frete, desconto_cupons,
         taxa_comissao, taxa_servico, outras_taxas,
         valor_recebido, recebido_em, previsto_para, atualizado_em, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_sn) DO UPDATE SET
         valor_produtos = excluded.valor_produtos,
         valor_frete = excluded.valor_frete,
         desconto_cupons = excluded.desconto_cupons,
         taxa_comissao = excluded.taxa_comissao,
         taxa_servico = excluded.taxa_servico,
         outras_taxas = excluded.outras_taxas,
         valor_recebido = excluded.valor_recebido,
         recebido_em = excluded.recebido_em,
         previsto_para = excluded.previsto_para,
         atualizado_em = excluded.atualizado_em,
         raw_json = excluded.raw_json`
    )
    .run(
      extrato.orderSn,
      extrato.valorProdutos,
      extrato.valorFrete,
      extrato.descontoCupons,
      extrato.taxaComissao,
      extrato.taxaServico,
      extrato.outrasTaxas,
      extrato.valorRecebido,
      extrato.recebidoEm,
      extrato.previstoPara,
      Date.now(),
      extrato.rawJson
    )

  // O extrato é a fonte da verdade da liberação, então escreve **sem COALESCE**:
  // um pedido que parecia pago (data prevista lida como efetiva) precisa poder
  // voltar a não-pago, e o COALESCE nunca limpava esse campo.
  getDb()
    .prepare('UPDATE orders SET escrow_amount = ?, escrow_released_at = ? WHERE order_sn = ?')
    .run(extrato.valorRecebido, extrato.recebidoEm, extrato.orderSn)
  // É a liberação que move a aba Enviado → Concluído.
  recomputeDerived(extrato.orderSn)
}

export function getRecebimento(orderSn: string): Recebimento | null {
  const row = getDb().prepare('SELECT * FROM order_income WHERE order_sn = ?').get(orderSn) as
    | RecebimentoRow
    | undefined
  return row ? rowToRecebimento(row) : null
}

/**
 * Pedidos para buscar extrato, os mais antigos primeiro.
 *
 * Por padrão só os que ainda não têm: extrato de pedido concluído não muda, e
 * refazer seria centenas de requisições para reescrever o mesmo valor. O
 * `refazer` existe para o caso de a Shopee corrigir algo retroativamente.
 */
export function pedidosParaExtrato(
  tab: string,
  opts: { refazer?: boolean; limite?: number } = {}
): { orderSn: string; orderId: string }[] {
  const limite = opts.limite ?? 5000
  const filtroExtrato = opts.refazer ? '' : 'AND i.order_sn IS NULL'
  return getDb()
    .prepare(
      `SELECT o.order_sn, o.shopee_order_id
         FROM orders o
         LEFT JOIN order_income i ON i.order_sn = o.order_sn
        WHERE o.tab = ?
          AND o.shopee_order_id IS NOT NULL
          ${filtroExtrato}
        ORDER BY o.created_at_shopee ASC
        LIMIT ?`
    )
    .all(tab, limite)
    .map((r) => {
      const row = r as { order_sn: string; shopee_order_id: string }
      return { orderSn: row.order_sn, orderId: row.shopee_order_id }
    })
}

/**
 * Reaplica a leitura aos extratos já guardados, usando o `raw_json`.
 *
 * Mesma ideia do reprocessamento dos pedidos: quando a interpretação muda —
 * como ao descobrir que `released_time` também traz data prevista —, a base
 * inteira se corrige sem uma requisição.
 */
export function reprocessarExtratos(): { lidos: number; corrigidos: number } {
  const rows = getDb()
    .prepare('SELECT order_sn, raw_json, recebido_em FROM order_income WHERE raw_json IS NOT NULL')
    .all() as { order_sn: string; raw_json: string; recebido_em: number | null }[]

  let corrigidos = 0
  for (const row of rows) {
    try {
      const extrato = parseOrderIncome(JSON.parse(row.raw_json), row.order_sn)
      if (!extrato) continue
      if (extrato.recebidoEm !== row.recebido_em) corrigidos++
      salvarRecebimento(extrato)
    } catch (err) {
      console.warn(`[extratos] ${row.order_sn} ilegível:`, err)
    }
  }
  return { lidos: rows.length, corrigidos }
}

export function contarSemExtrato(tab: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM orders o
         LEFT JOIN order_income i ON i.order_sn = o.order_sn
        WHERE o.tab = ? AND o.shopee_order_id IS NOT NULL AND i.order_sn IS NULL`
    )
    .get(tab) as { n: number }
  return row.n
}
