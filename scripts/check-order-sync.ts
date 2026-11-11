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

  const realCreatedAt = Date.parse('2026-11-08T14:00:00-03:00')
  const approximateCreatedAt = Date.parse('2026-11-09T00:00:00-03:00')
  await client.execute({ sql: 'UPDATE orders SET created_at_shopee = ? WHERE order_sn = ?', args: [realCreatedAt, orderSn] })
  await upsertShopeeOrderAsync({ orderSn, createdAtShopee: approximateCreatedAt, createdAtEstimated: true })
  assert.equal((await client.execute({ sql: 'SELECT created_at_shopee AS value FROM orders WHERE order_sn = ?', args: [orderSn] })).rows[0]?.value, realCreatedAt)
  const correctedCreatedAt = realCreatedAt + 60_000
  await upsertShopeeOrderAsync({ orderSn, createdAtShopee: correctedCreatedAt, createdAtEstimated: false })
  assert.equal((await client.execute({ sql: 'SELECT created_at_shopee AS value FROM orders WHERE order_sn = ?', args: [orderSn] })).rows[0]?.value, correctedCreatedAt)

  assert.equal(await upsertShopeeOrderAsync({
    orderSn, shopeeStatus: 'Entregue', shopeeTab: 'CONCLUIDO', items
  }), false)
  assert.equal((await client.execute({ sql: 'SELECT tab FROM orders WHERE order_sn = ?', args: [orderSn] })).rows[0]?.tab, 'CONCLUIDO')
  assert.equal((await client.execute({ sql: 'SELECT COUNT(*) AS n FROM order_items WHERE order_sn = ?', args: [orderSn] })).rows[0]?.n, 1)

  await upsertShopeeOrderAsync({ orderSn, shopeeStatus: 'Não pago' })
  assert.equal((await client.execute({ sql: 'SELECT tab FROM orders WHERE order_sn = ?', args: [orderSn] })).rows[0]?.tab, 'NAO_PAGO')
  await upsertShopeeOrderAsync({ orderSn, shopeeStatus: 'Cancelado', shopeeTab: 'CANCELADO' })
  assert.equal((await client.execute({ sql: 'SELECT tab FROM orders WHERE order_sn = ?', args: [orderSn] })).rows[0]?.tab, 'CANCELADO')

  const { recomporCatalogoDosPedidosAsync, listarProdutosAsync } = await import('../src/main/services/produtos')
  await upsertShopeeOrderAsync({
    orderSn: 'TEST-BOW-1', shopeeOrderId: '999', shopeeStatus: 'Enviado',
    shopeeTab: 'ENVIADO', totalAmount: 29.8,
    items: [{ itemName: 'Kit Laço de Cetim', modelName: 'Variação: Azul Bebê,20',
      itemId: 'bow-1', modelId: 'bow-blue-20', quantity: 2, lacos: 20,
      imageUrl: null, itemSku: null }]
  })
  await recomporCatalogoDosPedidosAsync()
  await client.execute({
    sql: 'INSERT INTO order_income (order_sn, valor_produtos, desconto_cupons, valor_recebido, atualizado_em) VALUES (?, ?, ?, ?, ?)',
    args: ['TEST-BOW-1', 28, -2, 22.4, Date.now()]
  })
  const bow = (await listarProdutosAsync()).find((product) => product.itemId === 'bow-1')
  assert.equal(bow?.tipo, 'LACOS')
  assert.equal(bow?.kitsVendidos, 2)
  assert.equal(bow?.lacosVendidos, 40)
  assert.equal(bow?.caixasVendidas, 0)
  assert.equal(bow?.vendas, 26)
  assert.equal(bow?.liquido, 22.4)
  assert.equal(bow?.pedidosSemLiquido, 0)
  const { pedidosParaAtualizarPagamentoAsync } = await import('../src/main/services/recebimentos')
  await upsertShopeeOrderAsync({ orderSn: 'OLD-PAYOUT', shopeeOrderId: '456', shopeeTab: 'CONCLUIDO' })
  await upsertShopeeOrderAsync({ orderSn: 'NEW-PAYOUT', shopeeOrderId: '789', shopeeTab: 'CONCLUIDO' })
  for (const [sn, updated] of [['OLD-PAYOUT', Date.now() - 2 * 86_400_000], ['NEW-PAYOUT', Date.now()]] as const) {
    await client.execute({ sql: 'INSERT INTO order_income (order_sn, atualizado_em) VALUES (?, ?)', args: [sn, updated] })
  }
  const incomeCandidates = await pedidosParaAtualizarPagamentoAsync()
  const finalIncomeCandidates = await pedidosParaAtualizarPagamentoAsync(true)
  assert.ok(incomeCandidates.some((order) => order.orderSn === 'OLD-PAYOUT'))
  assert.ok(finalIncomeCandidates.some((order) => order.orderSn === 'OLD-PAYOUT'))
  assert.ok(!finalIncomeCandidates.some((order) => order.orderSn === 'TEST-BOW-1'))
  const { pendingSyncPreview } = await import('../src/main/services/shopee/pendingPreview')
  const preview = await pendingSyncPreview()
  assert.equal(preview.status, 1)
  assert.equal(preview.tracking, 1)
  assert.equal(preview.payments, 1)
  assert.equal(preview.labels, 0)
  await upsertShopeeOrderAsync({ orderSn: 'READY-LABEL', shopeeOrderId: '1001',
    shopeeTab: 'A_ENVIAR', logisticsCode: 1, createdAtShopee: Date.now() })
  const { listOrdersMissingLabelDateAsync } = await import('../src/main/services/orders')
  assert.ok((await listOrdersMissingLabelDateAsync()).some((order) => order.orderSn === 'READY-LABEL'))
  assert.equal((await pendingSyncPreview()).labels, 1)
  assert.ok(!incomeCandidates.some((order) => order.orderSn === 'NEW-PAYOUT'))
  assert.deepEqual(bow?.variacoesDetalhe.map((variation) =>
    [variation.cor, variation.quantidadePorKit, variation.kitsVendidos, variation.lacosVendidos]
  ), [['Azul Bebê', 20, 2, 40]])

  const estimatedNextDay = Date.parse('2026-11-11T00:00:00-03:00')
  const actualSaleTime = Date.parse('2026-11-10T16:30:00-03:00')
  await upsertShopeeOrderAsync({ orderSn: 'TEST-DATE', shopeeTab: 'A_ENVIAR',
    createdAtShopee: estimatedNextDay, createdAtEstimated: true })
  const { parseOrderIncome } = await import('../src/main/services/shopee/client')
  const { salvarRecebimentoAsync } = await import('../src/main/services/recebimentos')
  const income = parseOrderIncome({ order_info: { order_sn: 'TEST-DATE' },
    tracking_info_list: [{ ctime: Math.floor(actualSaleTime / 1000) }] }, 'TEST-DATE')
  assert.equal(income?.criadoEm, actualSaleTime)
  await salvarRecebimentoAsync(income!)
  const correctedDay = (await client.execute(
    "SELECT date(created_at_shopee/1000,'unixepoch','-3 hours') AS dia FROM orders WHERE order_sn='TEST-DATE'"
  )).rows[0]?.dia
  assert.equal(correctedDay, '2026-11-10')
  client.close()
  console.log('Atualização de pedidos validada.')
} finally {
  await rm(directory, { recursive: true, force: true })
}
