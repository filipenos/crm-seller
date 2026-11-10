import type { DiaPainel, Painel, PainelOffsets } from './types'

export const DEFAULT_PAINEL_OFFSETS: PainelOffsets = { vendas: 0, previstas: 0, etiquetas: 0 }

export function validatePainelOffsets(value: PainelOffsets): PainelOffsets {
  for (const offset of [value.vendas, value.previstas, value.etiquetas]) {
    if (!Number.isInteger(offset) || Math.abs(offset) > 3650) throw new Error('Período do painel inválido.')
  }
  return value
}

export const DAILY_DASHBOARD_SQL = `
  SELECT 'vendas' AS grupo, date(o.created_at_shopee / 1000, 'unixepoch', '-3 hours') AS dia,
    COUNT(*) AS pedidos, COALESCE(SUM(o.total_amount), 0) AS total,
    COALESCE(SUM(i.valor_recebido), 0) AS liquido,
    SUM(CASE WHEN i.valor_recebido IS NULL THEN 1 ELSE 0 END) AS sem_liquido
  FROM orders o LEFT JOIN order_income i ON i.order_sn = o.order_sn
  WHERE o.tab NOT IN ('CANCELADO', 'NAO_PAGO') AND o.created_at_shopee >= ?1 AND o.created_at_shopee < ?2
  GROUP BY dia
  UNION ALL
  SELECT 'previstas', date(o.ship_by_date / 1000, 'unixepoch', '-3 hours', '-1 day'),
    COUNT(*), COALESCE(SUM(o.total_amount), 0), COALESCE(SUM(i.valor_recebido), 0),
    SUM(CASE WHEN i.valor_recebido IS NULL THEN 1 ELSE 0 END)
  FROM orders o LEFT JOIN order_income i ON i.order_sn = o.order_sn
  WHERE o.tab = 'A_ENVIAR' AND o.ship_by_date >= ?3 AND o.ship_by_date < ?4
  GROUP BY date(o.ship_by_date / 1000, 'unixepoch', '-3 hours', '-1 day')
  UNION ALL
  SELECT 'etiquetas', date(o.label_generated_at / 1000, 'unixepoch', '-3 hours'),
    COUNT(*), COALESCE(SUM(o.total_amount), 0), COALESCE(SUM(i.valor_recebido), 0),
    SUM(CASE WHEN i.valor_recebido IS NULL THEN 1 ELSE 0 END)
  FROM orders o LEFT JOIN order_income i ON i.order_sn = o.order_sn
  WHERE o.tab NOT IN ('CANCELADO', 'NAO_PAGO') AND o.label_generated_at >= ?5 AND o.label_generated_at < ?6
  GROUP BY date(o.label_generated_at / 1000, 'unixepoch', '-3 hours')
  UNION ALL
  SELECT 'sem_prazo', NULL, COUNT(*), 0, 0, 0 FROM orders
  WHERE tab = 'A_ENVIAR' AND ship_by_date IS NULL
`

export interface DailyDashboardRow {
  grupo: string
  dia: string | null
  pedidos: number
  total: number
  liquido: number
  sem_liquido: number
}

function dateKey(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function shiftedDay(today: string, offset: number): string {
  const [year, month, day] = today.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10)
}

export function dashboardDates(now = Date.now()): { today: string; bounds: number[] } {
  const today = dateKey(now)
  const ms = (date: string): number => new Date(`${date}T00:00:00-03:00`).getTime()
  return { today, bounds: [ms(shiftedDay(today, -6)), ms(today), ms(shiftedDay(today, 1)), ms(shiftedDay(today, 7))] }
}

export function dashboardPeriodBounds(today: string, offsets: PainelOffsets = DEFAULT_PAINEL_OFFSETS): number[] {
  validatePainelOffsets(offsets)
  const ms = (day: string): number => Date.parse(`${day}T00:00:00-03:00`)
  const vendasStart = -6 + offsets.vendas
  const previstasStart = offsets.previstas
  const etiquetasStart = -6 + offsets.etiquetas
  return [
    ms(shiftedDay(today, vendasStart)), ms(shiftedDay(today, vendasStart + 7)),
    ms(shiftedDay(today, previstasStart + 1)), ms(shiftedDay(today, previstasStart + 8)),
    ms(shiftedDay(today, etiquetasStart)), ms(shiftedDay(today, etiquetasStart + 7))
  ]
}

export function buildDailyDashboard(
  rows: DailyDashboardRow[], today: string, offsets: PainelOffsets = DEFAULT_PAINEL_OFFSETS
): Painel {
  const byGroup = new Map(rows.filter((row) => row.dia).map((row) => [`${row.grupo}:${row.dia}`, row]))
  const days = (group: string, offsets: number[]): DiaPainel[] => offsets.map((offset) => {
    const data = shiftedDay(today, offset)
    const row = byGroup.get(`${group}:${data}`)
    return {
      data, pedidos: Number(row?.pedidos ?? 0), total: Number(Number(row?.total ?? 0).toFixed(2)),
      liquido: Number(Number(row?.liquido ?? 0).toFixed(2)), semValorLiquido: Number(row?.sem_liquido ?? 0)
    }
  })
  return {
    vendasRecentes: days('vendas', [-6, -5, -4, -3, -2, -1, 0].map((day) => day + offsets.vendas)),
    postagensPrevistas: days('previstas', [0, 1, 2, 3, 4, 5, 6].map((day) => day + offsets.previstas)),
    etiquetasRecentes: days('etiquetas', [-6, -5, -4, -3, -2, -1, 0].map((day) => day + offsets.etiquetas)),
    semPrazoPostagem: Number(rows.find((row) => row.grupo === 'sem_prazo')?.pedidos ?? 0)
  }
}
