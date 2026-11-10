import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { MIGRATION_COUNT, migrationStatements } from '../src/main/db/migrations'
import { buildDailyDashboard, dashboardDates, dashboardPeriodBounds, DEFAULT_PAINEL_OFFSETS, DAILY_DASHBOARD_SQL, type DailyDashboardRow } from '../src/shared/dashboardDays'

const directory = await mkdtemp(join(tmpdir(), 'crm-dashboard-'))
const db = createClient({ url: `file:${join(directory, 'test.db')}`, intMode: 'number' })
const at = (day: string): number => Date.parse(`${day}T12:00:00-03:00`)

try {
  for (let index = 0; index < MIGRATION_COUNT - 2; index++) {
    for (const sql of migrationStatements(index)) await db.execute(sql)
  }
  const orders = [
    ['sale-today', 'ENVIADO', at('2026-11-09'), null, null, 100],
    ['sale-estimated-today', 'ENVIADO', Date.parse('2026-11-09T00:00:00-03:00'), null, null, 40],
    ['sale-estimated-month', 'ENVIADO', Date.parse('2026-11-01T00:00:00-03:00'), null, null, 20],
    ['post-tomorrow', 'A_ENVIAR', at('2026-11-07'), at('2026-11-10'), null, 50],
    ['post-next-week', 'A_ENVIAR', at('2026-11-07'), at('2026-11-18'), null, 60],
    ['labeled-today', 'ENVIADO', at('2026-11-02'), null, null, 80],
    ['no-forecast', 'A_ENVIAR', at('2026-11-08'), null, null, 30],
    ['cancelled', 'CANCELADO', at('2026-11-09'), null, null, 10]
  ] as const
  for (const [orderSn, tab, createdAt, shipBy, , amount] of orders) {
    await db.execute({
      sql: `INSERT INTO orders (order_sn, tab, created_at_shopee, ship_by_date, total_amount)
        VALUES (?, ?, ?, ?, ?)`,
      args: [orderSn, tab, createdAt, shipBy, amount]
    })
  }
  await db.execute({
    sql: `INSERT INTO order_events (event_key, order_sn, source, description, happened_at, created_at)
      VALUES (?, ?, 'logistics', 'Pedido em preparação', ?, ?)`,
    args: ['label-event', 'labeled-today', at('2026-11-09'), Date.now()]
  })
  for (const sql of migrationStatements(MIGRATION_COUNT - 2)) await db.execute(sql)
  assert.equal((await db.execute("SELECT label_generated_at AS value FROM orders WHERE order_sn='labeled-today'")).rows[0]?.value, at('2026-11-09'))
  for (const [orderSn, net] of [['sale-today', 70], ['post-tomorrow', 35], ['post-next-week', 42], ['labeled-today', 56]] as const) {
    await db.execute({ sql: 'INSERT INTO order_income (order_sn, valor_recebido, atualizado_em) VALUES (?, ?, ?)', args: [orderSn, net, Date.now()] })
  }
  const actualCreatedAt = Date.parse('2026-11-08T14:00:00-03:00')
  await db.execute({
    sql: 'INSERT INTO order_income (order_sn, valor_recebido, atualizado_em, raw_json) VALUES (?, ?, ?, ?)',
    args: ['sale-estimated-today', 28, Date.now(), JSON.stringify({ tracking_info_list: [{ ctime: actualCreatedAt / 1000 }] })]
  })
  const previousMonthCreatedAt = Date.parse('2026-10-31T15:00:00-03:00')
  await db.execute({
    sql: 'INSERT INTO order_income (order_sn, valor_recebido, atualizado_em, raw_json) VALUES (?, ?, ?, ?)',
    args: ['sale-estimated-month', 14, Date.now(), JSON.stringify({ tracking_info_list: [{ ctime: previousMonthCreatedAt / 1000 }] })]
  })
  for (const sql of migrationStatements(MIGRATION_COUNT - 1)) await db.execute(sql)
  assert.equal((await db.execute("SELECT created_at_shopee AS value FROM orders WHERE order_sn='sale-estimated-today'")).rows[0]?.value, actualCreatedAt)
  assert.equal((await db.execute("SELECT created_at_shopee AS value FROM orders WHERE order_sn='sale-estimated-month'")).rows[0]?.value, previousMonthCreatedAt)
  const { today } = dashboardDates(at('2026-11-09'))
  const rows = (await db.execute({ sql: DAILY_DASHBOARD_SQL, args: dashboardPeriodBounds(today) })).rows as unknown as DailyDashboardRow[]
  const panel = buildDailyDashboard(rows, today)
  assert.equal(panel.vendasRecentes.length, 7)
  assert.deepEqual(panel.vendasRecentes[6], { data: '2026-11-09', pedidos: 1, total: 100, liquido: 70, semValorLiquido: 0 })
  assert.deepEqual(panel.vendasRecentes[5], { data: '2026-11-08', pedidos: 2, total: 70, liquido: 28, semValorLiquido: 1 })
  assert.deepEqual(panel.postagensPrevistas[0], { data: '2026-11-09', pedidos: 1, total: 50, liquido: 35, semValorLiquido: 0 })
  assert.deepEqual(panel.etiquetasRecentes[6], { data: '2026-11-09', pedidos: 1, total: 80, liquido: 56, semValorLiquido: 0 })
  assert.equal(panel.semPrazoPostagem, 1)
  const previousSales = { ...DEFAULT_PAINEL_OFFSETS, vendas: -1 }
  const previousRows = (await db.execute({ sql: DAILY_DASHBOARD_SQL, args: dashboardPeriodBounds(today, previousSales) })).rows as unknown as DailyDashboardRow[]
  const previous = buildDailyDashboard(previousRows, today, previousSales)
  assert.deepEqual(previous.vendasRecentes[4], { data: '2026-10-31', pedidos: 1, total: 20, liquido: 14, semValorLiquido: 0 })
  assert.deepEqual(previous.postagensPrevistas[0], panel.postagensPrevistas[0])
  assert.deepEqual(previous.etiquetasRecentes[6], panel.etiquetasRecentes[6])
  const futureShipping = { ...DEFAULT_PAINEL_OFFSETS, previstas: 1 }
  const futureRows = (await db.execute({ sql: DAILY_DASHBOARD_SQL, args: dashboardPeriodBounds(today, futureShipping) })).rows as unknown as DailyDashboardRow[]
  const future = buildDailyDashboard(futureRows, today, futureShipping)
  assert.deepEqual(future.postagensPrevistas[1], { data: '2026-11-17', pedidos: 1, total: 60, liquido: 42, semValorLiquido: 0 })
  assert.deepEqual(future.vendasRecentes[6], panel.vendasRecentes[6])
  assert.throws(() => dashboardPeriodBounds(today, { ...DEFAULT_PAINEL_OFFSETS, vendas: 521 }), /inválido/)
  console.log('Painel diário validado.')
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}
