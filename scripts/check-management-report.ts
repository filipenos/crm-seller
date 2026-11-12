import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { MIGRATION_COUNT, migrationStatements } from '../src/main/db/migrations'
import { buildManagementReport, reportQueries, resolveReportPeriod, validateReportPeriod } from '../src/shared/managementReport'

const directory = await mkdtemp(join(tmpdir(), 'crm-report-'))
const db = createClient({ url: `file:${join(directory, 'test.db')}`, intMode: 'number' })
const at = (day: string): number => Date.parse(`${day}T12:00:00-03:00`)
const period = { inicio: '2026-11-08', fim: '2026-11-10' }

try {
  for (let index = 0; index < MIGRATION_COUNT; index++) {
    for (const sql of migrationStatements(index)) await db.execute(sql)
  }
  assert.deepEqual(resolveReportPeriod({ tipo: 'semana', data: '2026-11-08' }), { inicio: '2026-11-02', fim: '2026-11-08' })
  assert.deepEqual(resolveReportPeriod({ tipo: 'mes', mes: '2024-02' }), { inicio: '2024-02-01', fim: '2024-02-29' })
  assert.deepEqual(resolveReportPeriod({ tipo: 'esteMes' }, '2026-12-10'), { inicio: '2026-12-01', fim: '2026-12-10' })
  assert.deepEqual(resolveReportPeriod({ tipo: 'estaSemana' }, '2026-11-10'), { inicio: '2026-11-09', fim: '2026-11-10' })
  assert.deepEqual(resolveReportPeriod({ tipo: 'esteAno' }, '2026-11-10'), { inicio: '2026-01-01', fim: '2026-11-10' })
  assert.deepEqual(resolveReportPeriod({ tipo: 'ultimos7' }, '2026-11-10'), { inicio: '2026-11-04', fim: '2026-11-10' })
  assert.throws(() => validateReportPeriod({ inicio: '2026-02-30', fim: '2026-03-01' }), /válidas/)
  assert.throws(() => validateReportPeriod({ inicio: '2025-01-01', fim: '2026-12-31' }), /366 dias/)

  for (const [sn, tab, created, total, label, delivered] of [
    ['A', 'ENVIADO', at('2026-11-08'), 110, at('2026-11-09'), at('2026-11-10')],
    ['B', 'A_ENVIAR', at('2026-11-09'), 50, null, null],
    ['C', 'CANCELADO', at('2026-11-09'), 99, null, null],
    ['D', 'ENVIADO', at('2026-11-01'), 30, null, null],
    ['E', 'ENVIADO', at('2026-11-01'), 20, at('2026-11-07'), at('2026-11-07')]
  ] as const) {
    await db.execute({ sql: 'INSERT INTO orders (order_sn,tab,created_at_shopee,total_amount,label_generated_at,delivered_at) VALUES (?,?,?,?,?,?)', args: [sn, tab, created, total, label, delivered] })
  }
  await db.execute({ sql: "UPDATE orders SET buyer_username='cliente_retorno' WHERE order_sn IN ('A','B','C','D')", args: [] })
  await db.execute({ sql: "UPDATE orders SET buyer_username='cliente_unico' WHERE order_sn='E'", args: [] })
  for (const [sn, products, coupon, net, received] of [
    ['A', 100, -5, 70, at('2026-11-10')], ['B', 50, 0, 35, null], ['D', 30, 0, 30, null]
  ] as const) {
    await db.execute({ sql: 'INSERT INTO order_income (order_sn,valor_produtos,desconto_cupons,valor_recebido,recebido_em,atualizado_em) VALUES (?,?,?,?,?,?)', args: [sn, products, coupon, net, received, Date.now()] })
  }
  await db.execute({ sql: 'INSERT INTO order_items (order_sn,item_name,quantity,pecas,lacos) VALUES (?,?,?,?,?)', args: ['A', 'Caixas', 1, 5, null] })
  await db.execute({ sql: 'INSERT INTO order_items (order_sn,item_name,quantity,pecas,lacos) VALUES (?,?,?,?,?)', args: ['B', 'Laços', 2, null, 20] })
  for (const [key, day] of [['posted-1', '2026-11-09'], ['posted-2', '2026-11-10']] as const) {
    await db.execute({ sql: "INSERT INTO order_events (event_key,order_sn,source,description,happened_at,created_at) VALUES (?,?,'logistics','Pedido postado',?,?)", args: [key, 'A', at(day), Date.now()] })
  }
  await db.execute({ sql: "INSERT INTO order_events (event_key,order_sn,source,description,happened_at,created_at) VALUES (?,'E','logistics','Seu pedido foi coletado',?,?)", args: ['collected-1', at('2026-11-09'), Date.now()] })
  for (const [day, spend, sales] of [['2026-11-08', 10, 30], ['2026-11-09', 5, 20]] as const) {
    await db.execute({ sql: 'INSERT INTO daily_performance (day,synced_at,ads_cost,ads_sales) VALUES (?,?,?,?)', args: [Date.parse(`${day}T00:00:00-03:00`) / 1000, Date.now(), spend, sales] })
  }

  const read = async () => buildManagementReport(period, (await db.batch(reportQueries(period).map(({ sql, parameters }) => ({ sql, args: parameters })), 'read')).map((result) => [...result.rows] as Record<string, unknown>[]))
  const report = await read()
  assert.deepEqual(report.vendas, { pedidos: 2, brutoProdutos: 150, cupons: 5, faturado: 145, liquido: 105, semLiquido: 0, semExtrato: 0, taxas: 0, caixas: 5, lacos: 40 })
  assert.deepEqual(report.cancelamentos, { pedidos: 1, valor: 99, semExtrato: 1 })
  assert.equal(report.dias[1].cancelados, 1)
  assert.equal(report.dias[2].cancelados, 0)
  assert.deepEqual(report.recorrentes, [{ usuario: 'cliente_retorno', pedidosPeriodo: 2, pedidosTotal: 3 }])
  assert.deepEqual(report.movimento, { etiquetas: 1, despachados: 2, entregues: 1, recebimentos: 1, recebido: 70 })
  assert.deepEqual(report.coberturaLogistica, { semEtiqueta: 0, semPostagem: 0, semEntrega: 0 })
  assert.deepEqual(report.pendenciasAtuais, { aEnviar: 1, aEntregar: 1, aReceber: 2, valorAReceber: 65 })
  assert.equal(report.dias[1].despachados, 2)
  assert.equal(report.dias[2].despachados, 0)
  assert.equal(report.ads.diasComDados, 2)
  assert.equal(report.ads.investimento, 15)
  assert.equal(report.ads.roas, 3.33)
  assert.equal(report.ads.liquidoMenosAds, null)
  await db.execute({ sql: 'INSERT INTO daily_performance (day,synced_at) VALUES (?,?)', args: [Date.parse('2026-11-10T00:00:00-03:00') / 1000, Date.now()] })
  assert.equal((await read()).ads.liquidoMenosAds, 90)
  console.log('Relatório gerencial validado.')
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}
