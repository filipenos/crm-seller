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
  const { workAgenda, setCurrentWorkOrders } = await import('../src/main/services/workAgenda')
  const { searchWorkOrders } = await import('../src/shared/workSearch')
  const { filterWorkDayOrders, visibleWorkColors, workColorQuantity } = await import('../src/shared/workFilters')
  await ensureDefaultComposition()
  const { today } = dashboardDates()
  const insertOrder = async (sn: string, shipBy: number | null, status = 'NOVO', tab = 'A_ENVIAR', createdAt: number | null = null, labeled = false): Promise<void> => {
    await client.execute({ sql: 'INSERT INTO orders (order_sn, ship_by_date, internal_status, tab, created_at_shopee, label_generated_at) VALUES (?, ?, ?, ?, ?, ?)', args: [sn, shipBy, status, tab, createdAt, labeled ? at(today) : null] })
  }
  const insertItem = async (sn: string, name: string, model: string, quantity: number, pieces: number | null, bows: number | null, itemId: string): Promise<void> => {
    await client.execute({ sql: 'INSERT INTO order_items (order_sn, item_name, model_name, quantity, pecas, lacos, item_id) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [sn, name, model, quantity, pieces, bows, itemId] })
  }
  await client.execute({ sql: "INSERT INTO products (item_id, name, kind) VALUES ('boxes', 'Kit de caixas', 'CAIXAS'), ('bows', 'Kit de laços', 'LACOS')", args: [] })
  await insertOrder('box', at(shift(today, 1)), 'NOVO', 'A_ENVIAR', at(shift(today, -2)))
  await client.execute({ sql: 'UPDATE orders SET buyer_username = ?, child_name = ? WHERE order_sn = ?', args: ['cliente_teste', 'João', 'box'] })
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
  await insertItem('sent', 'Kit de caixas', '5 peças', 1, 5, null, 'boxes')
  await insertOrder('done-box', at(shift(today, 1)), 'NOVO', 'A_ENVIAR', null, true)
  await client.execute({ sql: 'UPDATE orders SET buyer_username = ? WHERE order_sn = ?', args: ['cliente_entrega', 'done-box'] })
  await insertItem('done-box', 'Kit de caixas', '5 peças', 1, 5, null, 'boxes')
  await insertOrder('done-bow', at(shift(today, 1)), 'ENVIADO', 'ENVIADO', null, true)
  await insertItem('done-bow', 'Kit de laços', 'Azul Bebê,20', 1, null, 20, 'bows')
  for (const [sn, itemId, stageId] of [
    ['packed', 'boxes', 10]
  ] as const) {
    await client.execute({ sql: `INSERT INTO order_item_work (order_sn, item_id, model_id, stage_id, updated_at)
      VALUES (?, ?, '', ?, ?)`, args: [sn, itemId, stageId, at(today)] })
  }
  await insertOrder('older-label', at(shift(today, -1)), 'NOVO', 'A_ENVIAR', null, true)
  await client.execute({ sql: 'UPDATE orders SET label_generated_at = ? WHERE order_sn = ?', args: [at(shift(today, -2)), 'older-label'] })
  await insertOrder('already-posted', at(shift(today, 1)), 'NOVO', 'A_ENVIAR', null, true)
  await client.execute({ sql: `INSERT INTO order_events (event_key, order_sn, source, description, happened_at, created_at) VALUES (?, ?, 'logistics', 'Pedido postado', ?, ?)`, args: ['posted', 'already-posted', at(today), at(today)] })

  const one = await workAgenda(1)
  assert.deepEqual(one.selecionados, [])
  assert.equal(one.dias.length, 1)
  assert.equal(one.dias[0].data, today)
  assert.equal(one.dias[0].postarAte, shift(today, 1))
  assert.equal(one.dias[0].pedidos.length, 7)
  assert.deepEqual(one.dias[0].pedidos.map((order) => order.orderSn), ['bow', 'box', 'already-posted', 'done-bow', 'done-box', 'packed', 'sent'])
  assert.equal(one.dias[0].pedidos[0].createdAtShopee, at(shift(today, -3)))
  assert.equal(one.dias[0].pedidos.find((order) => order.orderSn === 'box')?.buyerUsername, 'cliente_teste')
  assert.equal(one.dias[0].pedidosFeitos, 5)
  assert.equal(one.dias[0].pedidos.find((order) => order.orderSn === 'done-box')?.feito, true)
  assert.equal(one.dias[0].pedidos.find((order) => order.orderSn === 'sent')?.feito, true)
  assert.deepEqual(one.paraEntregar.map((order) => order.orderSn), ['older-label', 'done-box'])
  assert.equal(one.paraEntregar[1].buyerUsername, 'cliente_entrega')
  assert.deepEqual(searchWorkOrders(one, 'joao', false).map((order) => order.orderSn), ['box'])
  assert.deepEqual(searchWorkOrders(one, 'azul bebê', false).map((order) => order.orderSn), ['bow', 'done-bow'])
  assert.deepEqual(searchWorkOrders(one, 'cliente_entrega', true).map((order) => order.orderSn), [])
  assert.deepEqual(searchWorkOrders(one, 'done-box', true).map((order) => order.origem), [])
  assert.deepEqual(searchWorkOrders(one, 'box', true).map((order) => order.orderSn), ['box'])
  assert.equal(one.dias[0].pedidosLacos, 2)
  assert.equal(one.dias[0].pedidosCaixas, 4)
  assert.equal(one.dias[0].pedidosLacosFeitos, 1)
  assert.equal(one.dias[0].pedidosCaixasFeitos, 3)
  assert.equal(one.dias[0].lacosFeitos, 20)
  assert.deepEqual(one.dias[0].lacosFeitosPorCor, [{ nome: 'Azul Bebê', quantidade: 20 }])
  assert.equal(workColorQuantity(one.dias[0], 'Azul Bebê', {}, false), 60)
  assert.equal(workColorQuantity(one.dias[0], 'Azul Bebê', {}, true), 40)
  assert.equal(workColorQuantity(one.dias[0], 'Azul Bebê', { situacao: 'feitos' }, false), 20)
  const doneOnlyColor = {
    ...one.dias[0],
    lacosFeitosPorCor: [{ nome: 'Dourado', quantidade: 20 }],
    pedidos: one.dias[0].pedidos.map((order) => order.orderSn === 'done-bow'
      ? { ...order, producao: [{ tipo: 'LACOS' as const, cor: 'Dourado', feito: true }] }
      : order)
  }
  assert.equal(visibleWorkColors(doneOnlyColor, {}, true).includes('Dourado'), false)
  assert.equal(visibleWorkColors(doneOnlyColor, {}, false).includes('Dourado'), true)
  assert.equal(workColorQuantity(doneOnlyColor, 'Dourado', {}, false), 20)
  assert.deepEqual(filterWorkDayOrders(doneOnlyColor.pedidos, { tipo: 'LACOS', cor: 'Dourado' }, true), [])
  assert.equal(one.dias[0].caixasFeitas, 15)
  assert.equal(one.dias[0].caixas.reduce((sum, box) => sum + box.quantidade, 0), 10)
  assert.deepEqual(one.dias[0].lacos, [
    { nome: 'Azul Bebê', quantidade: 40 }, { nome: 'Rosa', quantidade: 10 }
  ])
  assert.equal(one.atrasados, 1)
  assert.equal(one.semPrazo, 1)
  const two = await workAgenda(2)
  assert.equal(two.dias[1].pedidos.length, 1)
  assert.equal(await setCurrentWorkOrders(['box', 'bow'], true), 2)
  assert.equal(await setCurrentWorkOrders(['later'], true), 1)
  assert.equal(await setCurrentWorkOrders(['done-box'], true), 0)
  assert.deepEqual((await workAgenda(1)).selecionados.map((order) => order.orderSn), ['bow', 'box', 'later'])
  assert.equal(await setCurrentWorkOrders(['bow'], false), 1)
  assert.deepEqual((await workAgenda(1)).selecionados.map((order) => order.orderSn), ['box', 'later'])
  await assert.rejects(() => setCurrentWorkOrders(['invalid order'], true), /pedidos válidos/)
  assert.equal(two.dias[1].caixas.reduce((sum, box) => sum + box.quantidade, 0), 5)
  const byDeadline = searchWorkOrders(two, 'kit de caixas', false)
  assert.equal(byDeadline.at(-1)?.orderSn, 'later')
  assert.ok(byDeadline.every((order, index) => index === 0 || (byDeadline[index - 1].postarAte ?? Infinity) <= (order.postarAte ?? Infinity)))
  await client.execute({ sql: 'UPDATE orders SET label_generated_at = ? WHERE order_sn = ?', args: [at(today), 'box'] })
  assert.deepEqual((await workAgenda(1)).selecionados.map((order) => order.orderSn), ['later'])
  await assert.rejects(workAgenda(11), /1 a 10/)
  client.close()
  console.log('Agenda de trabalho validada.')
} finally {
  const { closeDb } = await import('../src/main/db')
  closeDb()
  await rm(directory, { recursive: true, force: true })
}
