import { getAsyncDb } from '../db'
import type { OrderIncome as ExtratoShopee } from './shopee/client'
import { parseOrderIncome } from './shopee/client'
import type { Recebimento } from '@shared/types'
import { recomputeDerivedAsync } from './orders'

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

export async function salvarRecebimentoAsync(extrato: ExtratoShopee): Promise<void> {
  const db = getAsyncDb()
  const income = await db.prepare(
    `INSERT INTO order_income (
       order_sn, valor_produtos, valor_frete, desconto_cupons, taxa_comissao,
       taxa_servico, outras_taxas, valor_recebido, recebido_em, previsto_para,
       atualizado_em, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(order_sn) DO UPDATE SET
       valor_produtos = excluded.valor_produtos, valor_frete = excluded.valor_frete,
       desconto_cupons = excluded.desconto_cupons, taxa_comissao = excluded.taxa_comissao,
       taxa_servico = excluded.taxa_servico, outras_taxas = excluded.outras_taxas,
       valor_recebido = excluded.valor_recebido, recebido_em = excluded.recebido_em,
       previsto_para = excluded.previsto_para, atualizado_em = excluded.atualizado_em,
       raw_json = excluded.raw_json`
  )
  await income.run([
    extrato.orderSn, extrato.valorProdutos, extrato.valorFrete, extrato.descontoCupons,
    extrato.taxaComissao, extrato.taxaServico, extrato.outrasTaxas, extrato.valorRecebido,
    extrato.recebidoEm, extrato.previstoPara, Date.now(), extrato.rawJson
  ])
  if (extrato.criadoEm) {
    const created = await db.prepare('UPDATE orders SET created_at_shopee = ? WHERE order_sn = ?')
    await created.run([extrato.criadoEm, extrato.orderSn])
  }
  const escrow = await db.prepare(
    'UPDATE orders SET escrow_amount = ?, escrow_released_at = ? WHERE order_sn = ?'
  )
  await escrow.run([extrato.valorRecebido, extrato.recebidoEm, extrato.orderSn])
  await recomputeDerivedAsync(extrato.orderSn)
}

/**
 * Pedidos para buscar extrato, os mais antigos primeiro.
 *
 * Por padrão só os que ainda não têm: extrato de pedido concluído não muda, e
 * refazer seria centenas de requisições para reescrever o mesmo valor. O
 * `refazer` existe para o caso de a Shopee corrigir algo retroativamente.
 */
/**
 * Reaplica a leitura aos extratos já guardados, usando o `raw_json`.
 *
 * Mesma ideia do reprocessamento dos pedidos: quando a interpretação muda —
 * como ao descobrir que `released_time` também traz data prevista —, a base
 * inteira se corrige sem uma requisição.
 */
export async function reprocessarExtratosAsync(): Promise<{ lidos: number; corrigidos: number }> {
  const statement = await getAsyncDb().prepare(
    'SELECT order_sn, raw_json, recebido_em FROM order_income WHERE raw_json IS NOT NULL'
  )
  const rows = (await statement.all([])) as {
    order_sn: string; raw_json: string; recebido_em: number | null
  }[]
  let corrigidos = 0
  for (const row of rows) {
    try {
      const income = parseOrderIncome(JSON.parse(row.raw_json), row.order_sn)
      if (!income) continue
      if (income.recebidoEm !== row.recebido_em) corrigidos++
      await salvarRecebimentoAsync(income)
    } catch (error) {
      console.warn(`[extratos] ${row.order_sn} ilegível:`, error)
    }
  }
  return { lidos: rows.length, corrigidos }
}

/**
 * Quem precisa ter o extrato consultado.
 *
 * Duas situações: pedido sem extrato nenhum, e pedido **enviado** cujo dinheiro
 * ainda não caiu — esse muda sozinho quando a Shopee libera, e é o único que
 * vale reconsultar. Concluído com valor é fato consumado e fica de fora.
 *
 * "A enviar" entra na primeira situação de propósito: mesmo sem pagamento, o
 * extrato traz a **hora real da criação** do pedido, e sem ela a data vem do
 * número — que está no fuso da Shopee e joga pedido da tarde para o dia
 * seguinte.
 */
export async function pedidosParaAtualizarPagamentoAsync(): Promise<{
  orderSn: string; orderId: string
}[]> {
  const statement = await getAsyncDb().prepare(
    `SELECT o.order_sn, o.shopee_order_id FROM orders o
      LEFT JOIN order_income i ON i.order_sn = o.order_sn
     WHERE o.tab IN ('A_ENVIAR', 'ENVIADO', 'CONCLUIDO')
       AND o.shopee_order_id IS NOT NULL
       AND (i.order_sn IS NULL OR (o.tab = 'ENVIADO' AND i.recebido_em IS NULL))
     ORDER BY o.created_at_shopee ASC`
  )
  return ((await statement.all([])) as { order_sn: string; shopee_order_id: string }[])
    .map((row) => ({ orderSn: row.order_sn, orderId: row.shopee_order_id }))
}
