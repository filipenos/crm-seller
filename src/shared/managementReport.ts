import { dashboardDates, PRODUCT_SALES_SQL } from './dashboardDays'
import type { PeriodoRelatorio, RelatorioDia, RelatorioGerencial } from './types'

export type SelecaoPeriodoRelatorio =
  | { tipo: 'hoje' | 'estaSemana' | 'ultimos7' | 'esteMes' | 'ultimos30' | 'esteAno' }
  | { tipo: 'semana'; data: string }
  | { tipo: 'mes'; mes: string }
  | { tipo: 'ano'; ano: number }
  | { tipo: 'intervalo'; inicio: string; fim: string }

function addDays(day: string, offset: number): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10)
}

function validDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && addDays(day, 0) === day
}

export function validateReportPeriod(period: PeriodoRelatorio): PeriodoRelatorio {
  if (!validDay(period.inicio) || !validDay(period.fim)) throw new Error('Informe datas válidas para o relatório.')
  const days = (Date.parse(`${period.fim}T00:00:00Z`) - Date.parse(`${period.inicio}T00:00:00Z`)) / 86_400_000 + 1
  if (days < 1 || days > 366) throw new Error('Escolha um período de até 366 dias, com início antes do fim.')
  return period
}

export function resolveReportPeriod(selection: SelecaoPeriodoRelatorio, today = dashboardDates().today): PeriodoRelatorio {
  if (!validDay(today)) throw new Error('Data atual inválida.')
  const year = Number(today.slice(0, 4))
  const week = (day: string): PeriodoRelatorio => {
    if (!validDay(day)) throw new Error('Escolha uma data válida para a semana.')
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
    const inicio = addDays(day, -(weekday === 0 ? 6 : weekday - 1))
    return { inicio, fim: addDays(inicio, 6) }
  }
  switch (selection.tipo) {
    case 'hoje': return { inicio: today, fim: today }
    case 'estaSemana': return { inicio: week(today).inicio, fim: today }
    case 'ultimos7': return { inicio: addDays(today, -6), fim: today }
    case 'esteMes': return { inicio: `${today.slice(0, 7)}-01`, fim: today }
    case 'ultimos30': return { inicio: addDays(today, -29), fim: today }
    case 'esteAno': return { inicio: `${year}-01-01`, fim: today }
    case 'semana': return week(selection.data)
    case 'mes': {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selection.mes)) throw new Error('Escolha um mês válido.')
      const [selectedYear, selectedMonth] = selection.mes.split('-').map(Number)
      return { inicio: `${selection.mes}-01`, fim: addDays(`${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}-01`, -1) }
    }
    case 'ano': {
      if (!Number.isInteger(selection.ano) || selection.ano < 2020 || selection.ano > 2100) throw new Error('Escolha um ano válido.')
      return { inicio: `${selection.ano}-01-01`, fim: `${selection.ano}-12-31` }
    }
    case 'intervalo': return validateReportPeriod({ inicio: selection.inicio, fim: selection.fim })
  }
}

export function reportQueries(period: PeriodoRelatorio): { sql: string; parameters: number[] }[] {
  validateReportPeriod(period)
  const start = Date.parse(`${period.inicio}T00:00:00-03:00`)
  const end = Date.parse(`${addDays(period.fim, 1)}T00:00:00-03:00`)
  const range = [start, end]
  return [
    { sql: `SELECT date(o.created_at_shopee/1000,'unixepoch','-3 hours') AS dia,
        COUNT(*) AS pedidos, SUM(COALESCE(i.valor_produtos,o.total_amount,0)) AS bruto,
        SUM(ABS(COALESCE(i.desconto_cupons,0))) AS cupons, SUM(${PRODUCT_SALES_SQL}) AS faturado,
        SUM(COALESCE(i.valor_recebido,0)) AS liquido, SUM(i.valor_recebido IS NULL) AS sem_liquido,
        SUM(i.valor_produtos IS NULL) AS sem_extrato,
        SUM(ABS(COALESCE(i.taxa_comissao,0))+ABS(COALESCE(i.taxa_servico,0))+ABS(COALESCE(i.outras_taxas,0))) AS taxas
      FROM orders o LEFT JOIN order_income i ON i.order_sn=o.order_sn
      WHERE o.tab NOT IN ('CANCELADO','NAO_PAGO') AND o.created_at_shopee>=? AND o.created_at_shopee<?
      GROUP BY dia`, parameters: range },
    { sql: `SELECT date(o.created_at_shopee/1000,'unixepoch','-3 hours') AS dia,
        SUM(COALESCE(oi.pecas,0)*oi.quantity) AS caixas, SUM(COALESCE(oi.lacos,0)*oi.quantity) AS lacos
      FROM order_items oi JOIN orders o ON o.order_sn=oi.order_sn
      WHERE o.tab NOT IN ('CANCELADO','NAO_PAGO') AND o.created_at_shopee>=? AND o.created_at_shopee<?
      GROUP BY dia`, parameters: range },
    { sql: `SELECT date(label_generated_at/1000,'unixepoch','-3 hours') AS dia, COUNT(*) AS etiquetas
      FROM orders WHERE tab NOT IN ('CANCELADO','NAO_PAGO') AND label_generated_at>=? AND label_generated_at<?
      GROUP BY dia`, parameters: range },
    { sql: `SELECT date(primeiro/1000,'unixepoch','-3 hours') AS dia, COUNT(*) AS despachados
      FROM (SELECT order_sn, MIN(happened_at) AS primeiro FROM order_events
        WHERE source='logistics' AND (LOWER(description) LIKE '%postado%' OR LOWER(description) LIKE '%coletado%') GROUP BY order_sn)
      WHERE primeiro>=? AND primeiro<? GROUP BY dia`, parameters: range },
    { sql: `SELECT date(recebido_em/1000,'unixepoch','-3 hours') AS dia,
        COUNT(*) AS recebimentos, SUM(COALESCE(valor_recebido,0)) AS recebido
      FROM order_income WHERE recebido_em>=? AND recebido_em<? GROUP BY dia`, parameters: range },
    { sql: `SELECT date(delivered_at/1000,'unixepoch','-3 hours') AS dia, COUNT(*) AS entregues
      FROM orders WHERE tab NOT IN ('CANCELADO','NAO_PAGO') AND delivered_at>=? AND delivered_at<?
      GROUP BY dia`, parameters: range },
    { sql: `SELECT date(day,'unixepoch','-3 hours') AS dia, synced_at,
        ads_impressions, ads_clicks, ads_orders, ads_sales, ads_cost
      FROM daily_performance WHERE day>=? AND day<? ORDER BY day`, parameters: [Math.floor(start / 1000), Math.floor(end / 1000)] },
    { sql: `SELECT
        SUM(o.tab='A_ENVIAR') AS a_enviar,
        SUM(o.tab='ENVIADO' AND o.delivered_at IS NULL AND LOWER(COALESCE(o.shopee_status,'')) NOT LIKE '%entregue%' AND LOWER(COALESCE(o.shopee_status,'')) NOT LIKE '%delivered%') AS a_entregar,
        SUM(o.tab IN ('A_ENVIAR','ENVIADO','CONCLUIDO') AND i.recebido_em IS NULL AND i.valor_recebido IS NOT NULL) AS a_receber,
        SUM(CASE WHEN o.tab IN ('A_ENVIAR','ENVIADO','CONCLUIDO') AND i.recebido_em IS NULL THEN COALESCE(i.valor_recebido,0) ELSE 0 END) AS valor_a_receber
      FROM orders o LEFT JOIN order_income i ON i.order_sn=o.order_sn`, parameters: [] },
    { sql: `SELECT
        SUM(o.label_generated_at IS NULL) AS sem_etiqueta,
        SUM(NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_sn=o.order_sn
          AND e.source='logistics' AND (LOWER(e.description) LIKE '%postado%' OR LOWER(e.description) LIKE '%coletado%'))) AS sem_postagem,
        SUM(o.tab='CONCLUIDO' AND o.delivered_at IS NULL) AS sem_entrega
      FROM orders o WHERE o.tab IN ('ENVIADO','CONCLUIDO')
        AND o.created_at_shopee>=? AND o.created_at_shopee<?`, parameters: range },
    { sql: `WITH periodo AS (
        SELECT buyer_username AS usuario, COUNT(*) AS pedidos_periodo
        FROM orders
        WHERE tab NOT IN ('CANCELADO','NAO_PAGO')
          AND buyer_username IS NOT NULL AND TRIM(buyer_username) <> ''
          AND created_at_shopee>=? AND created_at_shopee<?
        GROUP BY buyer_username
      )
      SELECT p.usuario, p.pedidos_periodo, COUNT(o.order_sn) AS pedidos_total
      FROM periodo p JOIN orders o ON o.buyer_username=p.usuario
      WHERE o.tab NOT IN ('CANCELADO','NAO_PAGO')
      GROUP BY p.usuario, p.pedidos_periodo
      HAVING COUNT(o.order_sn) >= 2
      ORDER BY p.pedidos_periodo DESC, pedidos_total DESC, p.usuario`, parameters: range }
  ]
}

type Row = Record<string, unknown>
const num = (row: Row | undefined, key: string): number => Number(row?.[key] ?? 0)
const money = (value: number): number => Number(value.toFixed(2))

export function buildManagementReport(period: PeriodoRelatorio, results: Row[][]): RelatorioGerencial {
  validateReportPeriod(period)
  if (results.length !== 10) throw new Error('Consulta do relatório incompleta.')
  const days = new Map<string, RelatorioDia>()
  for (let day = period.inicio; day <= period.fim; day = addDays(day, 1)) {
    days.set(day, { data: day, pedidos: 0, faturado: 0, liquido: 0, despachados: 0, recebimentos: 0, recebido: 0, ads: null })
  }
  const totals = { bruto: 0, cupons: 0, taxas: 0, caixas: 0, lacos: 0, semLiquido: 0, semExtrato: 0, etiquetas: 0, entregues: 0,
    adsSpend: 0, adsSales: 0, adsOrders: 0, adsImpressions: 0, adsClicks: 0, syncedAt: 0, adsDays: 0 }
  for (const row of results[0]) {
    const day = days.get(String(row.dia))
    if (!day) continue
    day.pedidos = num(row, 'pedidos')
    day.faturado = money(num(row, 'faturado'))
    day.liquido = money(num(row, 'liquido'))
    totals.bruto += num(row, 'bruto'); totals.cupons += num(row, 'cupons'); totals.taxas += num(row, 'taxas')
    totals.semLiquido += num(row, 'sem_liquido')
    totals.semExtrato += num(row, 'sem_extrato')
  }
  for (const row of results[1]) { totals.caixas += num(row, 'caixas'); totals.lacos += num(row, 'lacos') }
  for (const row of results[2]) totals.etiquetas += num(row, 'etiquetas')
  for (const row of results[3]) {
    const day = days.get(String(row.dia))
    if (day) day.despachados = num(row, 'despachados')
  }
  for (const row of results[4]) {
    const day = days.get(String(row.dia))
    if (day) { day.recebimentos = num(row, 'recebimentos'); day.recebido = money(num(row, 'recebido')) }
  }
  for (const row of results[5]) totals.entregues += num(row, 'entregues')
  for (const row of results[6]) {
    const day = days.get(String(row.dia))
    if (!day) continue
    day.ads = money(num(row, 'ads_cost'))
    totals.adsDays++
    totals.adsSpend += num(row, 'ads_cost'); totals.adsSales += num(row, 'ads_sales')
    totals.adsOrders += num(row, 'ads_orders'); totals.adsImpressions += num(row, 'ads_impressions')
    totals.adsClicks += num(row, 'ads_clicks'); totals.syncedAt = Math.max(totals.syncedAt, num(row, 'synced_at'))
  }
  const daily = [...days.values()]
  const sum = (key: 'pedidos' | 'faturado' | 'liquido' | 'despachados' | 'recebimentos' | 'recebido'): number =>
    daily.reduce((total, day) => total + day[key], 0)
  const pendencias = results[7][0]
  const cobertura = results[8][0]
  const liquido = money(sum('liquido'))
  const investimento = money(totals.adsSpend)
  return {
    periodo: period,
    recorrentes: results[9].map((row) => ({ usuario: String(row.usuario), pedidosPeriodo: num(row, 'pedidos_periodo'), pedidosTotal: num(row, 'pedidos_total') })),
    vendas: { pedidos: sum('pedidos'), brutoProdutos: money(totals.bruto), cupons: money(totals.cupons),
      faturado: money(sum('faturado')), liquido, semLiquido: totals.semLiquido, semExtrato: totals.semExtrato,
      taxas: money(totals.taxas), caixas: totals.caixas, lacos: totals.lacos },
    movimento: { etiquetas: totals.etiquetas, despachados: sum('despachados'), entregues: totals.entregues,
      recebimentos: sum('recebimentos'), recebido: money(sum('recebido')) },
    coberturaLogistica: { semEtiqueta: num(cobertura, 'sem_etiqueta'),
      semPostagem: num(cobertura, 'sem_postagem'), semEntrega: num(cobertura, 'sem_entrega') },
    ads: { diasComDados: totals.adsDays, diasNoPeriodo: daily.length, sincronizadoEm: totals.syncedAt || null,
      investimento, vendasAtribuidas: money(totals.adsSales), pedidosAtribuidos: totals.adsOrders,
      impressoes: totals.adsImpressions, cliques: totals.adsClicks,
      roas: investimento > 0 ? Number((totals.adsSales / totals.adsSpend).toFixed(2)) : null,
      liquidoMenosAds: totals.adsDays === daily.length && totals.semLiquido === 0 ? money(liquido - investimento) : null },
    pendenciasAtuais: { aEnviar: num(pendencias, 'a_enviar'), aEntregar: num(pendencias, 'a_entregar'),
      aReceber: num(pendencias, 'a_receber'), valorAReceber: money(num(pendencias, 'valor_a_receber')) },
    dias: daily
  }
}
