import { getAsyncDb } from '../db'
import { buildDailyDashboard, dashboardDates, dashboardPeriodBounds, DEFAULT_PAINEL_OFFSETS, DAILY_DASHBOARD_SQL, type DailyDashboardRow } from '@shared/dashboardDays'
import type { MetricaPainel, Painel, PainelOffsets, SerieMensal } from '@shared/types'

/** Três séries de sete dias em uma única leitura remota do Turso. */
export async function montarPainel(offsets: PainelOffsets = DEFAULT_PAINEL_OFFSETS): Promise<Painel> {
  const { today } = dashboardDates()
  const rows = (await (await getAsyncDb().prepare(DAILY_DASHBOARD_SQL)).all(dashboardPeriodBounds(today, offsets))) as DailyDashboardRow[]
  return buildDailyDashboard(rows, today, offsets)
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
      sql: `SELECT strftime('%d', created_at_shopee / 1000, 'unixepoch', '-3 hours') AS dia, COUNT(*) AS v
              FROM orders
             WHERE tab != 'CANCELADO'
               AND strftime('%Y-%m', created_at_shopee / 1000, 'unixepoch', '-3 hours') = ?
             GROUP BY dia`
    },
    caixas: {
      sql: `SELECT strftime('%d', o.created_at_shopee / 1000, 'unixepoch', '-3 hours') AS dia,
                   COALESCE(SUM(i.pecas * i.quantity), 0) AS v
              FROM order_items i
              JOIN orders o ON o.order_sn = i.order_sn
             WHERE o.tab != 'CANCELADO' AND i.pecas IS NOT NULL
               AND strftime('%Y-%m', o.created_at_shopee / 1000, 'unixepoch', '-3 hours') = ?
             GROUP BY dia`
    },
    vendas: {
      sql: `SELECT strftime('%d', created_at_shopee / 1000, 'unixepoch', '-3 hours') AS dia,
                   COALESCE(SUM(total_amount), 0) AS v
              FROM orders
             WHERE tab != 'CANCELADO'
               AND strftime('%Y-%m', created_at_shopee / 1000, 'unixepoch', '-3 hours') = ?
             GROUP BY dia`
    },
    recebido: {
      sql: `SELECT strftime('%d', recebido_em / 1000, 'unixepoch', '-3 hours') AS dia,
                   COALESCE(SUM(valor_recebido), 0) AS v
              FROM order_income
             WHERE recebido_em IS NOT NULL
               AND strftime('%Y-%m', recebido_em / 1000, 'unixepoch', '-3 hours') = ?
             GROUP BY dia`
    },
    despachados: {
      sql: `SELECT strftime('%d', happened_at / 1000, 'unixepoch', '-3 hours') AS dia,
                   COUNT(DISTINCT order_sn) AS v
              FROM order_events
             WHERE source = 'logistics' AND LOWER(description) LIKE '%postado%'
               AND strftime('%Y-%m', happened_at / 1000, 'unixepoch', '-3 hours') = ?
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
