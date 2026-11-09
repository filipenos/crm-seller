import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { MIGRATION_COUNT, migrationStatements } from '../src/main/db/migrations'
import { buildDailyDashboard, dashboardDates, DAILY_DASHBOARD_SQL, type DailyDashboardRow } from '../src/shared/dashboardDays'

const directory = await mkdtemp(join(tmpdir(), 'crm-dashboard-'))
const db = createClient({ url: `file:${join(directory, 'test.db')}`, intMode: 'number' })
const at = (day: string): number => Date.parse(`${day}T12:00:00-03:00`)

try {
  for (let index = 0; index < MIGRATION_COUNT - 1; index++) {
    for (const sql of migrationStatements(index)) await db.execute(sql)
  }
  const orders = [
    ['sale-today', 'ENVIADO', at('2026-11-09'), null, null, 100],
    ['post-tomorrow', 'A_ENVIAR', at('2026-11-07'), at('2026-11-10'), null, 50],
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
  for (const sql of migrationStatements(MIGRATION_COUNT - 1)) await db.execute(sql)
  assert.equal((await db.execute("SELECT label_generated_at AS value FROM orders WHERE order_sn='labeled-today'")).rows[0]?.value, at('2026-11-09'))
  for (const [orderSn, net] of [['sale-today', 70], ['post-tomorrow', 35], ['labeled-today', 56]] as const) {
    await db.execute({ sql: 'INSERT INTO order_income (order_sn, valor_recebido, atualizado_em) VALUES (?, ?, ?)', args: [orderSn, net, Date.now()] })
  }
  const { today, bounds } = dashboardDates(at('2026-11-09'))
  const rows = (await db.execute({ sql: DAILY_DASHBOARD_SQL, args: bounds })).rows as unknown as DailyDashboardRow[]
  const panel = buildDailyDashboard(rows, today)
  assert.equal(panel.vendasRecentes.length, 7)
  assert.deepEqual(panel.vendasRecentes[6], { data: '2026-11-09', pedidos: 1, total: 100, liquido: 70, semValorLiquido: 0 })
  assert.deepEqual(panel.postagensPrevistas[1], { data: '2026-11-10', pedidos: 1, total: 50, liquido: 35, semValorLiquido: 0 })
  assert.deepEqual(panel.etiquetasRecentes[6], { data: '2026-11-09', pedidos: 1, total: 80, liquido: 56, semValorLiquido: 0 })
  assert.equal(panel.semPrazoPostagem, 1)
  console.log('Painel diário validado.')
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}
