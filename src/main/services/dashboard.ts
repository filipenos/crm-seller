import { getAsyncDb } from '../db'
import type { MetricaPainel, Painel, ResumoPeriodo, SerieMensal } from '@shared/types'

/**
 * Números do dia a dia, agregados no banco.
 *
 * Tudo é agrupado no **fuso local**, que é o dia como a pessoa vive. Vale
 * saber de onde vem cada data: recebimento e despacho têm hora real (extrato e
 * rastreio); a criação do pedido tem hora real quando o extrato já foi
 * consultado, e cai numa aproximação lida do número do pedido quando não —
 * aproximação que está no fuso da Shopee (UTC+8) e pode jogar um pedido da
 * tarde para o dia seguinte.
 */

/** Início do dia local, em ms. */
function inicioDoDia(diasAtras = 0): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - diasAtras)
  return d.getTime()
}

/** Palavra que o rastreio usa quando o pacote é deixado no ponto de coleta. */
const POSTADO = '%postado%'

type DashboardRow = Record<string, number>

function periodo(row: DashboardRow, prefixo: 'hoje' | 'sete' | 'trinta'): ResumoPeriodo {
  return {
    pedidos: row[`${prefixo}_pedidos`],
    vendas: Number(row[`${prefixo}_vendas`].toFixed(2)),
    caixas: row[`${prefixo}_caixas`],
    recebido: Number(row[`${prefixo}_recebido`].toFixed(2)),
    pedidosRecebidos: row[`${prefixo}_pedidos_recebidos`],
    despachados: row[`${prefixo}_despachados`]
  }
}

/** Monta o painel em uma viagem ao Turso e sem bloquear a thread do Electron. */
export async function montarPainel(): Promise<Painel> {
  const db = getAsyncDb()
  const statement = await db.prepare(`
    WITH limites AS (SELECT ? AS hoje, ? AS sete, ? AS trinta, ? AS amanha, ? AS prazo),
    pedidos AS (
      SELECT
        COUNT(CASE WHEN created_at_shopee >= limites.hoje THEN 1 END) AS hoje_pedidos,
        COUNT(CASE WHEN created_at_shopee >= limites.sete THEN 1 END) AS sete_pedidos,
        COUNT(CASE WHEN created_at_shopee >= limites.trinta THEN 1 END) AS trinta_pedidos,
        COALESCE(SUM(CASE WHEN created_at_shopee >= limites.hoje THEN total_amount ELSE 0 END), 0) AS hoje_vendas,
        COALESCE(SUM(CASE WHEN created_at_shopee >= limites.sete THEN total_amount ELSE 0 END), 0) AS sete_vendas,
        COALESCE(SUM(CASE WHEN created_at_shopee >= limites.trinta THEN total_amount ELSE 0 END), 0) AS trinta_vendas,
        COUNT(CASE WHEN tab = 'A_ENVIAR' THEN 1 END) AS a_enviar,
        COUNT(CASE WHEN tab = 'A_ENVIAR' AND ready_to_post = 1 THEN 1 END) AS prontos,
        COUNT(CASE WHEN tab = 'ENVIADO' THEN 1 END) AS em_transito,
        COUNT(CASE WHEN tab = 'A_ENVIAR' AND ship_by_date IS NOT NULL AND ship_by_date <= limites.prazo THEN 1 END) AS prazo_apertado
      FROM orders, limites
      WHERE created_at_shopee < limites.amanha AND tab != 'CANCELADO'
    ),
    caixas AS (
      SELECT
        COALESCE(SUM(CASE WHEN o.created_at_shopee >= limites.hoje THEN i.pecas * i.quantity ELSE 0 END), 0) AS hoje_caixas,
        COALESCE(SUM(CASE WHEN o.created_at_shopee >= limites.sete THEN i.pecas * i.quantity ELSE 0 END), 0) AS sete_caixas,
        COALESCE(SUM(CASE WHEN o.created_at_shopee >= limites.trinta THEN i.pecas * i.quantity ELSE 0 END), 0) AS trinta_caixas
      FROM order_items i JOIN orders o ON o.order_sn = i.order_sn, limites
      WHERE o.created_at_shopee < limites.amanha AND o.tab != 'CANCELADO' AND i.pecas IS NOT NULL
    ),
    recebidos AS (
      SELECT
        COALESCE(SUM(CASE WHEN recebido_em >= limites.hoje AND recebido_em < limites.amanha THEN valor_recebido ELSE 0 END), 0) AS hoje_recebido,
        COALESCE(SUM(CASE WHEN recebido_em >= limites.sete AND recebido_em < limites.amanha THEN valor_recebido ELSE 0 END), 0) AS sete_recebido,
        COALESCE(SUM(CASE WHEN recebido_em >= limites.trinta AND recebido_em < limites.amanha THEN valor_recebido ELSE 0 END), 0) AS trinta_recebido,
        COUNT(CASE WHEN recebido_em >= limites.hoje AND recebido_em < limites.amanha THEN 1 END) AS hoje_pedidos_recebidos,
        COUNT(CASE WHEN recebido_em >= limites.sete AND recebido_em < limites.amanha THEN 1 END) AS sete_pedidos_recebidos,
        COUNT(CASE WHEN recebido_em >= limites.trinta AND recebido_em < limites.amanha THEN 1 END) AS trinta_pedidos_recebidos
      FROM order_income, limites
    ),
    despachos AS (
      SELECT
        COUNT(DISTINCT CASE WHEN happened_at >= limites.hoje THEN order_sn END) AS hoje_despachados,
        COUNT(DISTINCT CASE WHEN happened_at >= limites.sete THEN order_sn END) AS sete_despachados,
        COUNT(DISTINCT CASE WHEN happened_at >= limites.trinta THEN order_sn END) AS trinta_despachados
      FROM order_events, limites
      WHERE source = 'logistics' AND happened_at < limites.amanha AND LOWER(description) LIKE '${POSTADO}'
    ),
    pendentes AS (
      SELECT COALESCE(SUM(i.valor_recebido), 0) AS a_receber, COUNT(*) AS pedidos_a_receber
      FROM order_income i JOIN orders o ON o.order_sn = i.order_sn
      WHERE i.recebido_em IS NULL AND o.tab != 'CANCELADO'
    )
    SELECT * FROM pedidos, caixas, recebidos, despachos, pendentes
  `)
  const row = (await statement.get([
    inicioDoDia(0), inicioDoDia(6), inicioDoDia(29), inicioDoDia(-1),
    Date.now() + 24 * 60 * 60 * 1000
  ])) as DashboardRow

  return {
    hoje: periodo(row, 'hoje'),
    ultimos7: periodo(row, 'sete'),
    ultimos30: periodo(row, 'trinta'),
    aEnviar: row.a_enviar,
    prontosParaPostar: row.prontos,
    emTransito: row.em_transito,
    aReceber: Number(row.a_receber.toFixed(2)),
    pedidosAReceber: row.pedidos_a_receber,
    prazoApertado: row.prazo_apertado
  }
}

/** Série diária de uma métrica dentro de um mês, sempre no fuso local. */
export async function serieMensal(
  metrica: MetricaPainel,
  ano: number,
  mes: number
): Promise<SerieMensal> {
  const db = getAsyncDb()
  const diasNoMes = new Date(ano, mes, 0).getDate()
  const mesTexto = `${ano}-${String(mes).padStart(2, '0')}`

  const consultas: Record<MetricaPainel, { sql: string; params?: unknown[] }> = {
    pedidos: {
      sql: `SELECT strftime('%d', created_at_shopee / 1000, 'unixepoch', 'localtime') AS dia, COUNT(*) AS v
              FROM orders
             WHERE tab != 'CANCELADO'
               AND strftime('%Y-%m', created_at_shopee / 1000, 'unixepoch', 'localtime') = ?
             GROUP BY dia`
    },
    caixas: {
      sql: `SELECT strftime('%d', o.created_at_shopee / 1000, 'unixepoch', 'localtime') AS dia,
                   COALESCE(SUM(i.pecas * i.quantity), 0) AS v
              FROM order_items i
              JOIN orders o ON o.order_sn = i.order_sn
             WHERE o.tab != 'CANCELADO' AND i.pecas IS NOT NULL
               AND strftime('%Y-%m', o.created_at_shopee / 1000, 'unixepoch', 'localtime') = ?
             GROUP BY dia`
    },
    vendas: {
      sql: `SELECT strftime('%d', created_at_shopee / 1000, 'unixepoch', 'localtime') AS dia,
                   COALESCE(SUM(total_amount), 0) AS v
              FROM orders
             WHERE tab != 'CANCELADO'
               AND strftime('%Y-%m', created_at_shopee / 1000, 'unixepoch', 'localtime') = ?
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

  const statement = await db.prepare(consultas[metrica].sql)
  const linhas = (await statement.all([mesTexto])) as { dia: string; v: number }[]
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
