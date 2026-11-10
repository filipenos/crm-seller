import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { MIGRATION_COUNT, migrationStatements } from '../src/main/db/migrations'
import { dashboardDates } from '../src/shared/dashboardDays'

const directory = await mkdtemp(join(tmpdir(), 'crm-work-'))
const url = `file:${join(directory, 'test.db')}`
process.env.CRM_SELLER_TEST_DATABASE_URL = url

function shift(day: string, offset: number): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10)
}

function at(day: string): number { return Date.parse(`${day}T12:00:00-03:00`) }

try {
  const client = createClient({ url, intMode: 'number' })
  for (let index = 0; index < MIGRATION_COUNT; index++) {
    for (const statement of migrationStatements(index)) await client.execute(statement)
  }
  const { ensureDefaultComposition } = await import('../src/main/services/composition')
  const { workAgenda } = await import('../src/main/services/workAgenda')
  await ensureDefaultComposition()
  const { today } = dashboardDates()
  const insertOrder = async (sn: string, shipBy: number | null, status = 'NOVO', tab = 'A_ENVIAR', createdAt: number | null = null): Promise<void> => {
    await client.execute({ sql: 'INSERT INTO orders (order_sn, ship_by_date, internal_status, tab, created_at_shopee) VALUES (?, ?, ?, ?, ?)', args: [sn, shipBy, status, tab, createdAt] })
  }
  const insertItem = async (sn: string, name: string, model: string, quantity: number, pieces: number | null, bows: number | null, itemId: string): Promise<void> => {
    await client.execute({ sql: 'INSERT INTO order_items (order_sn, item_name, model_name, quantity, pecas, lacos, item_id) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [sn, name, model, quantity, pieces, bows, itemId] })
  }
  await client.execute({ sql: "INSERT INTO products (item_id, name, kind) VALUES ('boxes', 'Kit de caixas', 'CAIXAS'), ('bows', 'Kit de laços', 'LACOS')", args: [] })
  await insertOrder('box', at(shift(today, 1)), 'NOVO', 'A_ENVIAR', at(shift(today, -2)))
  await insertItem('box', 'Kit de caixas', '10 peças / 2 de cada modelo', 1, 10, null, 'boxes')
  await insertOrder('bow', at(shift(today, 1)), 'NOVO', 'A_ENVIAR', at(shift(today, -3)))
  await insertItem('bow', 'Kit de laços', 'Azul Bebê,20', 2, null, 20, 'bows')
  await insertItem('bow', 'Kit de laços', 'Rosa,10', 1, null, 10, 'bows')
  await insertOrder('packed', at(shift(today, 1)), 'EMBALADO')
  await insertItem('packed', 'Kit de caixas', '5 peças', 1, 5, null, 'boxes')
  await insertOrder('later', at(shift(today, 2)))
  await insertItem('later', 'Kit de caixas', '5 peças', 1, 5, null, 'boxes')
  await insertOrder('late', at(today))
  await insertOrder('no-date', null)
  await insertOrder('sent', at(shift(today, 1)), 'NOVO', 'ENVIADO')

  const one = await workAgenda(1)
  assert.equal(one.dias.length, 1)
  assert.equal(one.dias[0].data, today)
  assert.equal(one.dias[0].postarAte, shift(today, 1))
  assert.equal(one.dias[0].pedidos.length, 3)
  assert.deepEqual(one.dias[0].pedidos.map((order) => order.orderSn), ['bow', 'box', 'packed'])
  assert.equal(one.dias[0].pedidos[0].createdAtShopee, at(shift(today, -3)))
  assert.equal(one.dias[0].pedidosLacos, 1)
  assert.equal(one.dias[0].pedidosCaixas, 1)
  assert.equal(one.dias[0].caixas.reduce((sum, box) => sum + box.quantidade, 0), 10)
  assert.deepEqual(one.dias[0].lacos, [
    { nome: 'Azul Bebê', quantidade: 40 }, { nome: 'Rosa', quantidade: 10 }
  ])
  assert.equal(one.atrasados, 1)
  assert.equal(one.semPrazo, 1)
  const two = await workAgenda(2)
  assert.equal(two.dias[1].pedidos.length, 1)
  assert.equal(two.dias[1].caixas.reduce((sum, box) => sum + box.quantidade, 0), 5)
  await assert.rejects(workAgenda(11), /1 a 10/)
  client.close()
  console.log('Agenda de trabalho validada.')
} finally {
  const { closeDb } = await import('../src/main/db')
  closeDb()
  await rm(directory, { recursive: true, force: true })
}
