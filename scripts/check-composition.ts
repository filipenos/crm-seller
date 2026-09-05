import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { MIGRATION_COUNT, migrationStatements } from '../src/main/db/migrations'

const directory = await mkdtemp(join(tmpdir(), 'crm-seller-composition-'))
const databasePath = join(directory, 'test.db')
process.env.CRM_SELLER_TEST_DATABASE_URL = `file:${databasePath}`

try {
  const client = createClient({ url: `file:${databasePath}`, intMode: 'number' })
  await client.execute('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
  for (let index = 0; index < MIGRATION_COUNT; index++) {
    for (const sql of migrationStatements(index)) await client.execute(sql)
    await client.execute({ sql: 'INSERT INTO schema_migrations (version) VALUES (?)', args: [index + 1] })
  }
  client.close()

  const {
    adjustCompositionStock,
    compositionSummary,
    createCompositionItem,
    createCompositionKitSize,
    createCompositionProductionLot,
    createCompositionVariant,
    deleteCompositionKitSize,
    deleteCompositionPurchase,
    deleteCompositionItem,
    deleteCompositionVariant,
    ensureDefaultComposition,
    previewCompositionProduction,
    recordCompositionPurchase,
    setCompositionPart,
    updateCompositionItem,
    updateCompositionKitSize,
    updateCompositionPurchase,
    updateCompositionVariant
  } = await import('../src/main/services/composition')

  assert.equal(await ensureDefaultComposition(), true)
  assert.equal(await ensureDefaultComposition(), false, 'o cadastro inicial deve ser idempotente')
  let summary = await compositionSummary()
  assert.equal(summary.itens.length, 18)
  assert.equal(summary.tamanhosKit.length, 10)

  const temporaryItemId = await createCompositionItem({
    nome: 'Item temporário', tipo: 'MATERIA_PRIMA', unidade: 'un'
  })
  await updateCompositionItem(temporaryItemId, {
    nome: 'Item alterado', tipo: 'COMPONENTE', unidade: 'cm', vendavel: true,
    controlaEstoque: true, custoReferencia: 2.5, perdaPercentual: 3, observacao: 'Teste CRUD'
  })
  summary = await compositionSummary()
  const temporaryItem = summary.itens.find((item) => item.id === temporaryItemId)!
  assert.equal(temporaryItem.nome, 'Item alterado')
  assert.equal(temporaryItem.tipo, 'COMPONENTE')
  assert.equal(temporaryItem.unidade, 'cm')
  assert.equal(temporaryItem.custoReferencia, 2.5)
  const initialBow = summary.itens.find((item) => item.nome === 'Laço')!
  await setCompositionPart({ itemId: initialBow.id, componenteId: temporaryItemId, quantidade: 1 })
  await deleteCompositionItem(temporaryItemId)
  summary = await compositionSummary()
  assert.equal(summary.itens.find((item) => item.id === temporaryItemId), undefined)
  assert.equal(summary.itens.find((item) => item.id === initialBow.id)?.partes.some((part) => part.itemId === temporaryItemId), false)

  const kit = summary.itens.find((item) => item.tipo === 'KIT')
  assert.ok(kit)
  assert.equal(kit.partes.length, 5)
  assert.equal(kit.controlaEstoque, true)
  await createCompositionKitSize({ itemId: kit.id, totalCaixas: 55, multiplicador: 11 })
  summary = await compositionSummary()
  const extraSize = summary.tamanhosKit.find((size) => size.totalCaixas === 55)!
  await updateCompositionKitSize(extraSize.id, { totalCaixas: 60, multiplicador: 12 })
  await deleteCompositionKitSize(extraSize.id)

  const themeId = await createCompositionVariant(kit.id, 'Tema teste')
  await updateCompositionVariant(themeId, 'Tema alterado')
  await deleteCompositionVariant(themeId)
  const initialConsumption = await previewCompositionProduction(kit.id, 1)
  assert.equal(initialConsumption.find((item) => item.itemNome === 'Cola')?.custoUnitario, 0.05)
  assert.equal(initialConsumption.find((item) => item.itemNome === 'Tinta')?.custoUnitario, 0.05)

  for (const box of summary.itens.filter((item) => item.tipo === 'CAIXA')) {
    for (const part of box.partes.filter((part) => part.quantidade === null)) {
      await setCompositionPart({ itemId: box.id, componenteId: part.itemId, quantidade: 1 })
    }
  }

  summary = await compositionSummary()
  const bow = summary.itens.find((item) => item.nome === 'Laço')!
  const wideRibbon = bow.partes.find((part) => part.nome === 'Fita cetim nº9')!
  await setCompositionPart({ itemId: bow.id, componenteId: wideRibbon.itemId, quantidade: 30 })

  summary = await compositionSummary()
  for (const material of summary.itens.filter((item) => item.tipo === 'MATERIA_PRIMA')) {
    if (material.nome === 'Tinta') continue
    const glue = material.nome === 'Cola'
    await recordCompositionPurchase({
      itemId: material.id,
      variantId: material.variantes[0]?.id ?? null,
      quantidade: glue ? 200 : 100,
      valor: glue ? 10 : 100
    })
  }
  const purchasedPaper = summary.itens.find((item) => item.nome === 'Papel')!
  await assert.rejects(() => deleteCompositionItem(purchasedPaper.id), /possui 1 compra/)

  const consumptions = await previewCompositionProduction(kit.id, 1)
  const expected = new Map([
    ['Papel', 5], ['Cola', 5], ['Tinta', 5], ['Fita cetim nº9', 60],
    ['Fita cetim nº1', 20], ['Meia pérola', 2]
  ])
  assert.equal(consumptions.length, expected.size)
  for (const consumption of consumptions) {
    assert.equal(consumption.quantidade, expected.get(consumption.itemNome))
    assert.equal(consumption.custoUnitario, ['Cola', 'Tinta'].includes(consumption.itemNome) ? 0.05 : 1)
  }

  await createCompositionProductionLot({
    itemId: kit.id,
    variantId: kit.variantes[0].id,
    kitSizeId: summary.tamanhosKit.find((size) => size.totalCaixas === 5)?.id,
    quantidade: 1,
    consumos: consumptions.map((item) => ({
      itemId: item.itemId,
      variantId: item.varianteId,
      quantidade: item.quantidade
    }))
  })
  summary = await compositionSummary()
  assert.equal(summary.lotes.length, 1)
  assert.equal(summary.lotes[0].custoReal, 87.5)
  assert.equal(summary.itens.find((item) => item.id === kit.id)?.estoque, 1)
  assert.equal(summary.itens.find((item) => item.nome === 'Papel')?.estoque, 95)

  const paper = summary.itens.find((item) => item.nome === 'Papel')!
  await adjustCompositionStock({
    itemId: paper.id,
    variantId: paper.variantes[0].id,
    quantidade: 5,
    observacao: 'Teste'
  })
  summary = await compositionSummary()
  assert.equal(summary.itens.find((item) => item.id === paper.id)?.estoque, 100)

  const unusedPurchase = summary.compras.find((purchase) => purchase.itemNome === 'Saco')!
  const sack = summary.itens.find((item) => item.nome === 'Saco')!
  await updateCompositionPurchase(unusedPurchase.id, {
    itemId: sack.id,
    variantId: sack.variantes[0].id,
    quantidade: 200,
    valor: 100
  })
  summary = await compositionSummary()
  assert.equal(summary.itens.find((item) => item.id === sack.id)?.estoque, 200)
  await deleteCompositionPurchase(unusedPurchase.id)
  summary = await compositionSummary()
  assert.equal(summary.compras.some((purchase) => purchase.id === unusedPurchase.id), false)
  assert.equal(summary.itens.find((item) => item.nome === 'Saco')?.estoque, 0)
  console.log('Composição validada: estrutura, custos, compras, lote e estoque.')
} finally {
  const { closeDb } = await import('../src/main/db')
  closeDb()
  await rm(directory, { recursive: true, force: true })
}
