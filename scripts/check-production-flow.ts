import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { MIGRATION_COUNT, migrationStatements } from '../src/main/db/migrations'

const directory = await mkdtemp(join(tmpdir(), 'crm-production-'))
const url = `file:${join(directory, 'test.db')}`
process.env.CRM_SELLER_TEST_DATABASE_URL = url

try {
  const client = createClient({ url, intMode: 'number' })
  for (let index = 0; index < MIGRATION_COUNT; index++) {
    for (const statement of migrationStatements(index)) await client.execute(statement)
  }
  const { listOrderProduction, actOnProductionItem, markOrderArtGenerated } = await import('../src/main/services/production')
  await client.execute("INSERT INTO products (item_id, name, kind, template_key) VALUES ('box', 'Caixas', 'CAIXAS', 'tema'), ('bow', 'Laços', 'LACOS', NULL)")
  await client.execute("INSERT INTO orders (order_sn, child_name) VALUES ('pedido', 'Ana')")
  await client.execute("INSERT INTO order_items (order_sn, item_id, model_id, item_name, quantity) VALUES ('pedido', 'box', 'v1', 'Caixas', 1), ('pedido', 'bow', 'v2', 'Laços', 2)")
  let items = await listOrderProduction('pedido')
  assert.deepEqual(items.map((item) => item.stage.code), ['WAITING_DATA', 'TO_PRODUCE'])
  items = await actOnProductionItem('pedido', 'box', 'v1', 'RECEIVE_DATA')
  assert.equal(items[0].stage.code, 'DATA_RECEIVED')
  await assert.rejects(actOnProductionItem('pedido', 'box', 'v1', 'APPROVE_ART'), /indisponível/)
  await markOrderArtGenerated('pedido', 'tema')
  items = await listOrderProduction('pedido')
  assert.equal(items[0].stage.code, 'ART_REVIEW')
  items = await actOnProductionItem('pedido', 'box', 'v1', 'APPROVE_ART')
  assert.equal(items[0].stage.code, 'ART_APPROVED')
  await markOrderArtGenerated('pedido', 'tema')
  items = await listOrderProduction('pedido')
  assert.equal(items[0].stage.code, 'ART_REVIEW')
  items = await actOnProductionItem('pedido', 'bow', 'v2', 'ADVANCE')
  assert.equal(items[1].stage.code, 'PRODUCING')
  await client.execute("DELETE FROM order_items WHERE order_sn = 'pedido'")
  await client.execute("INSERT INTO order_items (order_sn, item_id, model_id, item_name, quantity) VALUES ('pedido', 'box', 'v1', 'Caixas', 1), ('pedido', 'bow', 'v2', 'Laços', 2)")
  items = await listOrderProduction('pedido')
  assert.deepEqual(items.map((item) => item.stage.code), ['ART_REVIEW', 'PRODUCING'])
  client.close()
  console.log('Fluxos de produção validados.')
} finally {
  const { closeDb } = await import('../src/main/db')
  closeDb()
  await rm(directory, { recursive: true, force: true })
}
