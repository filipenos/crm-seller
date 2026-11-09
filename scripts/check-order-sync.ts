import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { MIGRATION_COUNT, migrationStatements } from '../src/main/db/migrations'

const directory = await mkdtemp(join(tmpdir(), 'crm-seller-orders-'))
const url = `file:${join(directory, 'test.db')}`
process.env.CRM_SELLER_TEST_DATABASE_URL = url

try {
  const client = createClient({ url, intMode: 'number' })
  await client.execute('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
  for (let index = 0; index < MIGRATION_COUNT; index++) {
    for (const sql of migrationStatements(index)) await client.execute(sql)
    await client.execute({ sql: 'INSERT INTO schema_migrations (version) VALUES (?)', args: [index + 1] })
  }

  const { upsertShopeeOrderAsync } = await import('../src/main/services/orders')
  const items = [{ itemName: 'Kit de teste', modelName: null, quantity: 1, imageUrl: null, itemSku: null }]
  const orderSn = 'TEST-ORDER-1'
  assert.equal(await upsertShopeeOrderAsync({
    orderSn, shopeeOrderId: '123', shopeeStatus: 'To Ship', shopeeTab: 'ENVIADO', items
  }), true)
  assert.equal((await client.execute({ sql: 'SELECT tab FROM orders WHERE order_sn = ?', args: [orderSn] })).rows[0]?.tab, 'ENVIADO')
  assert.equal((await client.execute({ sql: 'SELECT COUNT(*) AS n FROM order_items WHERE order_sn = ?', args: [orderSn] })).rows[0]?.n, 1)

  assert.equal(await upsertShopeeOrderAsync({
    orderSn, shopeeStatus: 'Entregue', shopeeTab: 'CONCLUIDO', items
  }), false)
  assert.equal((await client.execute({ sql: 'SELECT tab FROM orders WHERE order_sn = ?', args: [orderSn] })).rows[0]?.tab, 'CONCLUIDO')
  assert.equal((await client.execute({ sql: 'SELECT COUNT(*) AS n FROM order_items WHERE order_sn = ?', args: [orderSn] })).rows[0]?.n, 1)

  await upsertShopeeOrderAsync({ orderSn, shopeeStatus: 'Não pago' })
  assert.equal((await client.execute({ sql: 'SELECT tab FROM orders WHERE order_sn = ?', args: [orderSn] })).rows[0]?.tab, 'NAO_PAGO')

  const { recomporCatalogoDosPedidosAsync, listarProdutosAsync } = await import('../src/main/services/produtos')
  await upsertShopeeOrderAsync({
    orderSn: 'TEST-BOW-1', shopeeStatus: 'Enviado', shopeeTab: 'ENVIADO', totalAmount: 29.8,
    items: [{ itemName: 'Kit Laço de Cetim', modelName: 'Variação: Azul Bebê,20',
      itemId: 'bow-1', modelId: 'bow-blue-20', quantity: 2, lacos: 20,
      imageUrl: null, itemSku: null }]
  })
  await recomporCatalogoDosPedidosAsync()
  await client.execute({
    sql: 'INSERT INTO order_income (order_sn, valor_recebido, atualizado_em) VALUES (?, ?, ?)',
    args: ['TEST-BOW-1', 22.4, Date.now()]
  })
  const bow = (await listarProdutosAsync()).find((product) => product.itemId === 'bow-1')
  assert.equal(bow?.tipo, 'LACOS')
  assert.equal(bow?.kitsVendidos, 2)
  assert.equal(bow?.lacosVendidos, 40)
  assert.equal(bow?.caixasVendidas, 0)
  assert.equal(bow?.vendas, 29.8)
  assert.equal(bow?.liquido, 22.4)
  assert.equal(bow?.pedidosSemLiquido, 0)
  assert.deepEqual(bow?.variacoesDetalhe.map((variation) =>
    [variation.cor, variation.quantidadePorKit, variation.kitsVendidos, variation.lacosVendidos]
  ), [['Azul Bebê', 20, 2, 40]])
  client.close()
  console.log('Atualização de pedidos validada.')
} finally {
  await rm(directory, { recursive: true, force: true })
}
