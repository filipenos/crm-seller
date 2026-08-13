import { getDb } from '../db'
import type { MetricaPainel, Painel, ResumoPeriodo, SerieMensal } from '@shared/types'

/**
 * Números do dia a dia, agregados no banco.
 *
 * Um cuidado que muda a leitura: a **data do pedido não tem hora** — ela é
 * lida do número do pedido (AAMMDD), porque o card da Shopee não traz criação.
 * Então "hoje" aqui é o dia inteiro, e comparar períodos por dia é o máximo de
 * granularidade honesta. Já o recebimento e a postagem têm hora de verdade,
 * porque vêm do extrato e do rastreio.
 */

/** Início do dia local, em ms — as datas de pedido são gravadas em UTC 00:00. */
function inicioDoDia(diasAtras = 0): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - diasAtras)
  return d.getTime()
}

/**
 * A data do pedido vem de `Date.UTC(ano, mês, dia)`, então comparar com o
 * início do dia local erraria por causa do fuso. Aqui o corte é feito na mesma
 * régua: meia-noite UTC do dia procurado.
 */
function inicioDoDiaUtc(diasAtras = 0): number {
  const d = new Date()
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() - diasAtras)
}

/** Palavra que o rastreio usa quando o pacote é deixado no ponto de coleta. */
const POSTADO = '%postado%'

function resumo(diasAtras: number): ResumoPeriodo {
  const db = getDb()
  const desdeUtc = inicioDoDiaUtc(diasAtras)
  const desde = inicioDoDia(diasAtras)

  const pedidos = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS vendas
         FROM orders
        WHERE created_at_shopee >= ?
          AND tab != 'CANCELADO'`
    )
    .get(desdeUtc) as { n: number; vendas: number }

  // Caixas: o kit diz quantas peças tem, e o pedido pode levar mais de um kit.
  const caixas = db
    .prepare(
      `SELECT COALESCE(SUM(i.pecas * i.quantity), 0) AS n
         FROM order_items i
         JOIN orders o ON o.order_sn = i.order_sn
        WHERE o.created_at_shopee >= ?
          AND o.tab != 'CANCELADO'
          AND i.pecas IS NOT NULL`
    )
    .get(desdeUtc) as { n: number }

  const recebido = db
    .prepare(
      `SELECT COALESCE(SUM(valor_recebido), 0) AS total, COUNT(*) AS n
         FROM order_income
        WHERE recebido_em >= ?`
    )
    .get(desde) as { total: number; n: number }

  const despachados = db
    .prepare(
      `SELECT COUNT(DISTINCT order_sn) AS n
         FROM order_events
        WHERE source = 'logistics'
          AND happened_at >= ?
          AND LOWER(description) LIKE ?`
    )
    .get(desde, POSTADO) as { n: number }

  return {
    pedidos: pedidos.n,
    vendas: Number(pedidos.vendas.toFixed(2)),
    caixas: caixas.n,
    recebido: Number(recebido.total.toFixed(2)),
    pedidosRecebidos: recebido.n,
    despachados: despachados.n
  }
}

export function montarPainel(): Painel {
  const db = getDb()

  const aEnviar = db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE tab = 'A_ENVIAR'")
    .get() as { n: number }
  const prontos = db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE tab = 'A_ENVIAR' AND ready_to_post = 1")
    .get() as { n: number }
  const emTransito = db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE tab = 'ENVIADO'")
    .get() as { n: number }

  // A receber: valor já calculado pela Shopee que ainda não caiu na conta.
  const aReceber = db
    .prepare(
      `SELECT COALESCE(SUM(i.valor_recebido), 0) AS total, COUNT(*) AS n
         FROM order_income i
         JOIN orders o ON o.order_sn = i.order_sn
        WHERE i.recebido_em IS NULL
          AND o.tab != 'CANCELADO'`
    )
    .get() as { total: number; n: number }

  // Prazo estourando: o que precisa sair hoje para não virar multa.
  const prazoHoje = db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
        WHERE tab = 'A_ENVIAR' AND ship_by_date IS NOT NULL AND ship_by_date <= ?`
    )
    .get(Date.now() + 24 * 60 * 60 * 1000) as { n: number }

  return {
    hoje: resumo(0),
    ultimos7: resumo(6),
    ultimos30: resumo(29),
    aEnviar: aEnviar.n,
    prontosParaPostar: prontos.n,
    emTransito: emTransito.n,
    aReceber: Number(aReceber.total.toFixed(2)),
    pedidosAReceber: aReceber.n,
    prazoApertado: prazoHoje.n
  }
}

/**
 * Série diária de uma métrica dentro de um mês.
 *
 * O agrupamento por dia respeita a origem de cada data: pedido vem do número
 * (AAMMDD, gravado como meia-noite UTC) e é agrupado em UTC; recebimento e
 * despacho têm hora real e são agrupados no fuso local — que é o dia como a
 * pessoa vive.
 */
export function serieMensal(metrica: MetricaPainel, ano: number, mes: number): SerieMensal {
  const db = getDb()
  const diasNoMes = new Date(ano, mes, 0).getDate()
  const mesTexto = `${ano}-${String(mes).padStart(2, '0')}`

  const consultas: Record<MetricaPainel, { sql: string; params?: unknown[] }> = {
    pedidos: {
      sql: `SELECT strftime('%d', created_at_shopee / 1000, 'unixepoch') AS dia, COUNT(*) AS v
              FROM orders
             WHERE tab != 'CANCELADO'
               AND strftime('%Y-%m', created_at_shopee / 1000, 'unixepoch') = ?
             GROUP BY dia`
    },
    caixas: {
      sql: `SELECT strftime('%d', o.created_at_shopee / 1000, 'unixepoch') AS dia,
                   COALESCE(SUM(i.pecas * i.quantity), 0) AS v
              FROM order_items i
              JOIN orders o ON o.order_sn = i.order_sn
             WHERE o.tab != 'CANCELADO' AND i.pecas IS NOT NULL
               AND strftime('%Y-%m', o.created_at_shopee / 1000, 'unixepoch') = ?
             GROUP BY dia`
    },
    vendas: {
      sql: `SELECT strftime('%d', created_at_shopee / 1000, 'unixepoch') AS dia,
                   COALESCE(SUM(total_amount), 0) AS v
              FROM orders
             WHERE tab != 'CANCELADO'
               AND strftime('%Y-%m', created_at_shopee / 1000, 'unixepoch') = ?
             GROUP BY dia`
    },
    recebido: {
      sql: `SELECT strftime('%d', recebido_em / 1000, 'unixepoch', 'localtime') AS dia,
                   COALESCE(SUM(valor_recebido), 0) AS v
              FROM order_income
             WHERE recebido_em IS NOT NULL
               AND strftime('%Y-%m', recebido_em / 1000, 'unixepoch', 'localtime') = ?
             GROUP BY dia`
    },
    despachados: {
      sql: `SELECT strftime('%d', happened_at / 1000, 'unixepoch', 'localtime') AS dia,
                   COUNT(DISTINCT order_sn) AS v
              FROM order_events
             WHERE source = 'logistics' AND LOWER(description) LIKE '%postado%'
               AND strftime('%Y-%m', happened_at / 1000, 'unixepoch', 'localtime') = ?
             GROUP BY dia`
    }
  }

  const linhas = db.prepare(consultas[metrica].sql).all(mesTexto) as { dia: string; v: number }[]
  const porDia = new Map(linhas.map((l) => [Number(l.dia), l.v]))

  const dias = Array.from({ length: diasNoMes }, (_, i) => ({
    dia: i + 1,
    valor: Number((porDia.get(i + 1) ?? 0).toFixed(2))
  }))

  return {
    metrica,
    ano,
    mes,
    dias,
    total: Number(dias.reduce((soma, d) => soma + d.valor, 0).toFixed(2))
  }
}
