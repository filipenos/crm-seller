import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { MIGRATION_COUNT, migrationStatements } from '../src/main/db/migrations'

const directory = await mkdtemp(join(tmpdir(), 'crm-tracking-'))
const url = `file:${join(directory, 'test.db')}`
process.env.CRM_SELLER_TEST_DATABASE_URL = url
const client = createClient({ url, intMode: 'number' })

try {
  for (let index = 0; index < MIGRATION_COUNT; index++) {
    for (const sql of migrationStatements(index)) await client.execute(sql)
  }
  const { closeDb } = await import('../src/main/db')
  const { listHistoricalTrackingCandidates, listSentTrackingTargets, saveTrackingCheckpoints } = await import('../src/main/services/shopee/trackingHistory')
  await client.execute({ sql: "INSERT INTO orders (order_sn,shopee_order_id,tab,created_at_shopee) VALUES ('A','123','CONCLUIDO',?)", args: [Date.now()] })
  await client.execute({ sql: "INSERT INTO orders (order_sn,shopee_order_id,tab,created_at_shopee) VALUES ('B','456','ENVIADO',?)", args: [Date.now()] })
  assert.equal((await listHistoricalTrackingCandidates(false)).length, 1)
  assert.equal((await listHistoricalTrackingCandidates(true, new Set(['B']))).length, 0)
  assert.equal((await listHistoricalTrackingCandidates(true, new Set(['A']))).length, 1)
  assert.deepEqual(await listSentTrackingTargets(), [{ orderSn: 'B', shopeeOrderId: '456', logisticsStatus: null }])

  const at = Date.parse('2026-10-08T12:00:00-03:00')
  const checkpoints = [
    { description: 'Pedido em preparação', happenedAt: at, rawJson: '{}' },
    { description: 'Seu pedido foi coletado', happenedAt: at + 86_400_000, rawJson: '{}' },
    { description: 'Pedido entregue ao destinatário', happenedAt: at + 3 * 86_400_000, rawJson: '{}' }
  ]
  assert.equal((await saveTrackingCheckpoints('A', checkpoints)).newEvents, 3)
  assert.equal((await saveTrackingCheckpoints('A', checkpoints)).newEvents, 0)
  const row = (await client.execute("SELECT label_generated_at,delivered_at FROM orders WHERE order_sn='A'")).rows[0]
  assert.equal(row?.label_generated_at, at)
  assert.equal(row?.delivered_at, at + 3 * 86_400_000)
  await client.execute({ sql: "UPDATE orders SET delivered_at=? WHERE order_sn='B'", args: [at] })
  assert.equal((await listSentTrackingTargets()).length, 0)
  await client.execute({ sql: "INSERT INTO tracking_audit (order_sn,checked_at) VALUES ('A',?)", args: [Date.now()] })
  assert.equal((await listHistoricalTrackingCandidates(true)).length, 0)
  closeDb()
  console.log('Rastreio histórico validado.')
} finally {
  client.close()
  await rm(directory, { recursive: true, force: true })
}
