import { randomUUID } from 'crypto'
import { getAsyncDb } from '../db'
import {
  TIPOS_ITEM_COMPOSICAO,
  UNIDADES,
  type CompraComposicao,
  type ConsumoProducao,
  type ItemComposicao,
  type LoteProducaoComposicao,
  type MovimentoComposicao,
  type ResumoComposicao,
  type TamanhoKitComposicao,
  type TipoItemComposicao,
  type Unidade,
  type VarianteComposicao
} from '@shared/types'

interface ItemRow {
  id: number
  slug: string | null
  name: string
  kind: TipoItemComposicao
  unit: Unidade
  sellable: number
  stock_controlled: number
  reference_cost: number | null
  waste_percent: number
  notes: string | null
}

interface PartRow {
  id: number
  parent_item_id: number
  child_item_id: number
  quantity: number | null
  position: number
}

interface VariantRow {
  id: number
  item_id: number
  name: string
  stock: number
  average_cost: number | null
}

interface CostResult {
  value: number | null
  incomplete: boolean
}

function round(value: number, decimals = 4): number {
  return Number(value.toFixed(decimals))
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} deve ser maior que zero.`)
  return value
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} não pode ser negativo.`)
  return value
}

function requiredName(value: string): string {
  const name = value.trim()
  if (!name) throw new Error('Informe o nome do item.')
  return name
}

function validKind(value: string): TipoItemComposicao {
  if (!(TIPOS_ITEM_COMPOSICAO as readonly string[]).includes(value)) {
    throw new Error(`Tipo de item inválido: ${value}`)
  }
  return value as TipoItemComposicao
}

function validUnit(value: string): Unidade {
  if (!(UNIDADES as readonly string[]).includes(value)) throw new Error(`Unidade inválida: ${value}`)
  return value as Unidade
}

async function ensureItem(input: {
  slug: string
  name: string
  kind: TipoItemComposicao
  unit: Unidade
  sellable?: boolean
  stockControlled?: boolean
  referenceCost?: number
}): Promise<number> {
  const db = getAsyncDb()
  const now = Date.now()
  const insert = await db.prepare(
    `INSERT INTO composition_items
      (slug, name, kind, unit, sellable, stock_controlled, reference_cost, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING`
  )
  await insert.run([
    input.slug, input.name, input.kind, input.unit, input.sellable ? 1 : 0,
    input.stockControlled ? 1 : 0, input.referenceCost ?? null, now, now
  ])
  const select = await db.prepare('SELECT id FROM composition_items WHERE slug = ?')
  const item = (await select.get([input.slug])) as { id: number }
  const variant = await db.prepare(
    `INSERT INTO composition_variants (item_id, name) VALUES (?, 'Padrão')
     ON CONFLICT(item_id, name) DO NOTHING`
  )
  await variant.run([item.id])
  return item.id
}

async function ensurePart(parentId: number, childId: number, quantity: number | null, position: number): Promise<void> {
  const statement = await getAsyncDb().prepare(
    `INSERT INTO composition_parts (parent_item_id, child_item_id, quantity, position)
     VALUES (?, ?, ?, ?) ON CONFLICT(parent_item_id, child_item_id) DO NOTHING`
  )
  await statement.run([parentId, childId, quantity, position])
}

/** Cadastra somente a estrutura conhecida; nunca sobrescreve ajustes posteriores. */
export async function ensureDefaultComposition(): Promise<boolean> {
  const db = getAsyncDb()
  const countStatement = await db.prepare('SELECT COUNT(*) AS n FROM composition_items')
  const count = (await countStatement.get([])) as { n: number }
  if (count.n > 0) return false

  const papel = await ensureItem({ slug: 'papel', name: 'Papel', kind: 'MATERIA_PRIMA', unit: 'folha', stockControlled: true })
  const cola = await ensureItem({ slug: 'cola', name: 'Cola', kind: 'MATERIA_PRIMA', unit: 'aplicação', stockControlled: true, referenceCost: 0.05 })
  const tinta = await ensureItem({ slug: 'tinta', name: 'Tinta', kind: 'MATERIA_PRIMA', unit: 'aplicação', stockControlled: false, referenceCost: 0.05 })
  const cetim9 = await ensureItem({ slug: 'fita-cetim-9', name: 'Fita cetim nº9', kind: 'MATERIA_PRIMA', unit: 'cm', stockControlled: true })
  const cetim1 = await ensureItem({ slug: 'fita-cetim-1', name: 'Fita cetim nº1', kind: 'MATERIA_PRIMA', unit: 'cm', stockControlled: true })
  const perola = await ensureItem({ slug: 'meia-perola', name: 'Meia pérola', kind: 'MATERIA_PRIMA', unit: 'un', stockControlled: true })
  const saco = await ensureItem({ slug: 'saco', name: 'Saco', kind: 'MATERIA_PRIMA', unit: 'un', stockControlled: true })
  const bolha = await ensureItem({ slug: 'plastico-bolha', name: 'Plástico bolha', kind: 'MATERIA_PRIMA', unit: 'm', stockControlled: true })
  const saquinho = await ensureItem({ slug: 'saquinho-individual', name: 'Saquinho individual', kind: 'MATERIA_PRIMA', unit: 'un', stockControlled: true })
  const etiqueta = await ensureItem({ slug: 'etiqueta', name: 'Etiqueta', kind: 'MATERIA_PRIMA', unit: 'un', stockControlled: true })

  const laco = await ensureItem({ slug: 'laco', name: 'Laço', kind: 'COMPONENTE', unit: 'un' })
  await ensurePart(laco, cetim9, 26, 1)
  await ensurePart(laco, cetim1, 10, 2)
  await ensurePart(laco, perola, 1, 3)

  const boxes: number[] = []
  for (const [slug, name, hasBow] of [
    ['caixa-piramide', 'Caixa pirâmide', true],
    ['caixa-milk', 'Caixa milk', true],
    ['caixa-coracao', 'Caixa coração', false],
    ['maleta-quadrada', 'Maleta quadrada', false],
    ['maleta-redonda', 'Maleta redonda', false]
  ] as const) {
    const box = await ensureItem({ slug, name, kind: 'CAIXA', unit: 'un' })
    boxes.push(box)
    await ensurePart(box, papel, 1, 1)
    await ensurePart(box, cola, 1, 2)
    await ensurePart(box, tinta, 1, 3)
    if (hasBow) await ensurePart(box, laco, 1, 4)
  }

  const shipping = await ensureItem({
    slug: 'embalagem-envio', name: 'Embalagem para envio', kind: 'COMPONENTE', unit: 'un'
  })
  await ensurePart(shipping, saco, 1, 1)
  await ensurePart(shipping, bolha, 1, 2)
  await ensurePart(shipping, saquinho, 3, 3)
  await ensurePart(shipping, etiqueta, 1, 4)

  const kit = await ensureItem({
    slug: 'kit-caixas', name: 'Kit de caixas', kind: 'KIT', unit: 'un', sellable: true,
    stockControlled: true
  })
  for (let index = 0; index < boxes.length; index++) await ensurePart(kit, boxes[index], 1, index + 1)
  const size = await db.prepare(
    `INSERT INTO composition_kit_sizes (kit_item_id, total_units, multiplier)
     VALUES (?, ?, ?) ON CONFLICT(kit_item_id, total_units) DO NOTHING`
  )
  for (let total = 5; total <= 50; total += 5) await size.run([kit, total, total / 5])
  return true
}

async function loadCore(): Promise<{
  itemRows: ItemRow[]
  partRows: PartRow[]
  variantRows: VariantRow[]
  averageByItem: Map<number, number>
}> {
  const db = getAsyncDb()
  const [itemRows, partRows, variantRows, costs] = await db.queryBatch([
    { sql: `SELECT id, slug, name, kind, unit, sellable, stock_controlled,
      reference_cost, waste_percent, notes FROM composition_items ORDER BY kind, name` },
    { sql: `SELECT id, parent_item_id, child_item_id, quantity, position
      FROM composition_parts ORDER BY parent_item_id, position, id` },
    { sql: `SELECT v.id, v.item_id, v.name,
      COALESCE((SELECT SUM(m.quantity) FROM composition_stock_moves m
        WHERE m.item_id = v.item_id AND m.variant_id = v.id), 0) AS stock,
      (SELECT CASE WHEN SUM(p.quantity) > 0 THEN SUM(p.total + p.shipping) / SUM(p.quantity) END
        FROM composition_purchases p WHERE p.variant_id = v.id) AS average_cost
      FROM composition_variants v ORDER BY v.item_id, v.name` },
    { sql: `SELECT item_id, SUM(total + shipping) / SUM(quantity) AS average_cost
      FROM composition_purchases GROUP BY item_id` }
  ])
  return {
    itemRows: itemRows as ItemRow[],
    partRows: partRows as PartRow[],
    variantRows: variantRows as VariantRow[],
    averageByItem: new Map((costs as { item_id: number; average_cost: number }[]).map((row) => [row.item_id, row.average_cost]))
  }
}

function buildItems(core: Awaited<ReturnType<typeof loadCore>>): {
  items: ItemComposicao[]
  costs: Map<number, CostResult>
} {
  const itemById = new Map(core.itemRows.map((item) => [item.id, item]))
  const partsByParent = new Map<number, PartRow[]>()
  for (const part of core.partRows) {
    const list = partsByParent.get(part.parent_item_id) ?? []
    list.push(part)
    partsByParent.set(part.parent_item_id, list)
  }
  const variantsByItem = new Map<number, VarianteComposicao[]>()
  for (const variant of core.variantRows) {
    const list = variantsByItem.get(variant.item_id) ?? []
    list.push({
      id: variant.id,
      nome: variant.name,
      estoque: round(variant.stock, 3),
      custoMedio: variant.average_cost === null ? null : round(variant.average_cost)
    })
    variantsByItem.set(variant.item_id, list)
  }
  const costs = new Map<number, CostResult>()
  const calculate = (id: number, path: number[] = []): CostResult => {
    const cached = costs.get(id)
    if (cached) return cached
    if (path.includes(id)) return { value: null, incomplete: true }
    const item = itemById.get(id)
    if (!item) return { value: null, incomplete: true }
    const parts = partsByParent.get(id) ?? []
    if (parts.length === 0) {
      const value = core.averageByItem.get(id) ?? item.reference_cost
      const result = { value: value === null || value === undefined ? null : round(value), incomplete: value === null || value === undefined }
      costs.set(id, result)
      return result
    }
    let total = 0
    let priced = false
    let incomplete = false
    for (const part of parts) {
      if (part.quantity === null) { incomplete = true; continue }
      const child = calculate(part.child_item_id, [...path, id])
      if (child.value === null) incomplete = true
      else { total += child.value * part.quantity; priced = true }
      incomplete ||= child.incomplete
    }
    const result = {
      value: priced ? round(total * (1 + item.waste_percent / 100)) : null,
      incomplete
    }
    costs.set(id, result)
    return result
  }
  for (const item of core.itemRows) calculate(item.id)

  const items = core.itemRows.map((item): ItemComposicao => {
    const itemCost = costs.get(item.id) ?? { value: null, incomplete: true }
    const variants = variantsByItem.get(item.id) ?? []
    return {
      id: item.id,
      nome: item.name,
      tipo: item.kind,
      unidade: item.unit,
      vendavel: item.sellable === 1,
      controlaEstoque: item.stock_controlled === 1,
      custoReferencia: item.reference_cost,
      perdaPercentual: item.waste_percent,
      observacao: item.notes,
      estoque: round(variants.reduce((sum, variant) => sum + variant.estoque, 0), 3),
      custoEstimado: itemCost.value,
      custoIncompleto: itemCost.incomplete,
      variantes: variants,
      partes: (partsByParent.get(item.id) ?? []).map((part) => {
        const child = itemById.get(part.child_item_id)!
        const childCost = costs.get(part.child_item_id) ?? { value: null, incomplete: true }
        return {
          id: part.id,
          itemId: part.child_item_id,
          nome: child.name,
          unidade: child.unit,
          quantidade: part.quantity,
          custo: part.quantity === null || childCost.value === null
            ? null : round(part.quantity * childCost.value),
          incompleto: part.quantity === null || childCost.incomplete || childCost.value === null
        }
      })
    }
  })
  return { items, costs }
}

export async function compositionSummary(): Promise<ResumoComposicao> {
  const db = getAsyncDb()
  const core = await loadCore()
  const { items, costs } = buildItems(core)
  const [sizeRows, purchaseRows, moveRows, lotRows, consumptionRows] = await db.queryBatch([
    { sql: 'SELECT id, kit_item_id, total_units, multiplier FROM composition_kit_sizes ORDER BY total_units' },
    { sql: `SELECT p.id, p.item_id, i.name AS item_name, p.variant_id, v.name AS variant_name,
      p.quantity, p.total, p.shipping, p.bought_at, p.supplier
      FROM composition_purchases p JOIN composition_items i ON i.id = p.item_id
      LEFT JOIN composition_variants v ON v.id = p.variant_id
      ORDER BY p.bought_at DESC, p.id DESC LIMIT 300` },
    { sql: `SELECT m.id, m.item_id, i.name AS item_name, v.name AS variant_name,
      m.quantity, i.unit, m.reason, m.happened_at, m.notes
      FROM composition_stock_moves m JOIN composition_items i ON i.id = m.item_id
      LEFT JOIN composition_variants v ON v.id = m.variant_id
      ORDER BY m.happened_at DESC, m.id DESC LIMIT 300` },
    { sql: `SELECT l.id, l.item_id, i.name AS item_name, l.variant_id,
      v.name AS variant_name, l.kit_size_id, s.total_units, l.quantity,
      l.estimated_unit_cost, l.actual_total_cost, l.produced_at, l.notes
      FROM composition_production_lots l JOIN composition_items i ON i.id = l.item_id
      LEFT JOIN composition_variants v ON v.id = l.variant_id
      LEFT JOIN composition_kit_sizes s ON s.id = l.kit_size_id
      ORDER BY l.produced_at DESC, l.id DESC LIMIT 200` },
    { sql: `SELECT c.lot_id, c.item_id, i.name AS item_name, i.unit,
      c.variant_id, c.quantity, c.unit_cost, c.total_cost
      FROM composition_lot_consumptions c JOIN composition_items i ON i.id = c.item_id` }
  ])
  const typedSizeRows = sizeRows as { id: number; kit_item_id: number; total_units: number; multiplier: number }[]
  const typedPurchaseRows = purchaseRows as {
      id: number; item_id: number; item_name: string; variant_id: number | null;
      variant_name: string | null; quantity: number; total: number; shipping: number;
      bought_at: number; supplier: string | null
    }[]
  const typedMoveRows = moveRows as {
      id: number; item_id: number; item_name: string; variant_name: string | null;
      quantity: number; unit: string; reason: MovimentoComposicao['motivo'];
      happened_at: number; notes: string | null
    }[]
  const typedLotRows = lotRows as {
      id: number; item_id: number; item_name: string; variant_id: number | null;
      variant_name: string | null; kit_size_id: number | null; total_units: number | null; quantity: number;
      estimated_unit_cost: number; actual_total_cost: number; produced_at: number; notes: string | null
    }[]
  const typedConsumptionRows = consumptionRows as {
      lot_id: number; item_id: number; item_name: string; unit: string;
      variant_id: number | null; quantity: number; unit_cost: number; total_cost: number
    }[]
  const stockByItem = new Map(items.map((item) => [item.id, item.estoque]))
  const consumptionsByLot = new Map<number, ConsumoProducao[]>()
  for (const consumption of typedConsumptionRows) {
    const list = consumptionsByLot.get(consumption.lot_id) ?? []
    list.push({
      itemId: consumption.item_id,
      itemNome: consumption.item_name,
      unidade: consumption.unit,
      varianteId: consumption.variant_id,
      quantidade: consumption.quantity,
      estoque: stockByItem.get(consumption.item_id) ?? 0,
      custoUnitario: consumption.unit_cost,
      custoTotal: consumption.total_cost
    })
    consumptionsByLot.set(consumption.lot_id, list)
  }
  const tamanhosKit: TamanhoKitComposicao[] = typedSizeRows.map((row) => ({
    id: row.id,
    kitItemId: row.kit_item_id,
    totalCaixas: row.total_units,
    multiplicador: row.multiplier,
    custoEstimado: costs.get(row.kit_item_id)?.value === null || costs.get(row.kit_item_id)?.value === undefined
      ? null : round(costs.get(row.kit_item_id)!.value! * row.multiplier)
  }))
  const compras: CompraComposicao[] = typedPurchaseRows.map((row) => ({
    id: row.id, itemId: row.item_id, itemNome: row.item_name,
    varianteId: row.variant_id, varianteNome: row.variant_name,
    quantidade: row.quantity, valor: row.total, frete: row.shipping,
    custoUnitario: round((row.total + row.shipping) / row.quantity),
    compradoEm: row.bought_at, fornecedor: row.supplier
  }))
  const movimentos: MovimentoComposicao[] = typedMoveRows.map((row) => ({
    id: row.id, itemId: row.item_id, itemNome: row.item_name,
    varianteNome: row.variant_name, quantidade: row.quantity, unidade: row.unit,
    motivo: row.reason, aconteceuEm: row.happened_at, observacao: row.notes
  }))
  const lotes: LoteProducaoComposicao[] = typedLotRows.map((row) => ({
    id: row.id, itemId: row.item_id, itemNome: row.item_name,
    varianteId: row.variant_id, varianteNome: row.variant_name,
    tamanhoKitId: row.kit_size_id, totalCaixas: row.total_units, quantidade: row.quantity,
    custoUnitarioEstimado: row.estimated_unit_cost, custoReal: row.actual_total_cost,
    custoUnitarioReal: round(row.actual_total_cost / row.quantity), produzidoEm: row.produced_at,
    observacao: row.notes, consumos: consumptionsByLot.get(row.id) ?? []
  }))
  return { itens: items, tamanhosKit, compras, movimentos, lotes }
}

async function validateVariant(itemId: number, variantId: number | null): Promise<void> {
  if (variantId === null) return
  const statement = await getAsyncDb().prepare(
    'SELECT 1 FROM composition_variants WHERE id = ? AND item_id = ?'
  )
  if (!(await statement.get([variantId, itemId]))) {
    throw new Error('A versão selecionada não pertence ao item informado.')
  }
}

export async function createCompositionItem(input: {
  nome: string
  tipo: string
  unidade: string
  vendavel?: boolean
  controlaEstoque?: boolean
  custoReferencia?: number | null
  perdaPercentual?: number
  observacao?: string | null
}): Promise<number> {
  const db = getAsyncDb()
  const now = Date.now()
  const statement = await db.prepare(
    `INSERT INTO composition_items
      (name, kind, unit, sellable, stock_controlled, reference_cost, waste_percent, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const cost = input.custoReferencia === null || input.custoReferencia === undefined
    ? null : nonNegative(input.custoReferencia, 'Custo de referência')
  const result = await statement.run([
    requiredName(input.nome), validKind(input.tipo), validUnit(input.unidade),
    input.vendavel ? 1 : 0, input.controlaEstoque ? 1 : 0, cost,
    nonNegative(input.perdaPercentual ?? 0, 'Perda'), input.observacao?.trim() || null, now, now
  ])
  const id = Number(result.lastInsertRowid)
  const variant = await db.prepare("INSERT INTO composition_variants (item_id, name) VALUES (?, 'Padrão')")
  await variant.run([id])
  return id
}

export async function updateCompositionItem(id: number, input: {
  nome?: string
  tipo?: string
  unidade?: string
  vendavel?: boolean
  controlaEstoque?: boolean
  custoReferencia?: number | null
  perdaPercentual?: number
  observacao?: string | null
}): Promise<void> {
  const db = getAsyncDb()
  const updates: { sql: string; value: unknown }[] = []
  if (input.nome !== undefined) updates.push({ sql: 'name', value: requiredName(input.nome) })
  if (input.tipo !== undefined) updates.push({ sql: 'kind', value: validKind(input.tipo) })
  if (input.unidade !== undefined) updates.push({ sql: 'unit', value: validUnit(input.unidade) })
  if (input.vendavel !== undefined) updates.push({ sql: 'sellable', value: input.vendavel ? 1 : 0 })
  if (input.controlaEstoque !== undefined) updates.push({ sql: 'stock_controlled', value: input.controlaEstoque ? 1 : 0 })
  if (input.custoReferencia !== undefined) updates.push({
    sql: 'reference_cost',
    value: input.custoReferencia === null ? null : nonNegative(input.custoReferencia, 'Custo de referência')
  })
  if (input.perdaPercentual !== undefined) updates.push({
    sql: 'waste_percent', value: nonNegative(input.perdaPercentual, 'Perda')
  })
  if (input.observacao !== undefined) updates.push({ sql: 'notes', value: input.observacao?.trim() || null })
  if (updates.length === 0) return
  const statement = await db.prepare(
    `UPDATE composition_items SET ${updates.map((update) => `${update.sql} = ?`).join(', ')},
      updated_at = ? WHERE id = ?`
  )
  await statement.run([...updates.map((update) => update.value), Date.now(), id])
}

export async function deleteCompositionItem(id: number): Promise<void> {
  const db = getAsyncDb()
  const [purchaseRows, producedLotRows, consumedLotRows] = await db.queryBatch([
    { sql: 'SELECT COUNT(*) AS n FROM composition_purchases WHERE item_id = ?', parameters: [id] },
    { sql: 'SELECT COUNT(*) AS n FROM composition_production_lots WHERE item_id = ?', parameters: [id] },
    { sql: 'SELECT COUNT(DISTINCT lot_id) AS n FROM composition_lot_consumptions WHERE item_id = ?', parameters: [id] }
  ])
  const purchases = Number((purchaseRows[0] as { n: number } | undefined)?.n ?? 0)
  const lots = Number((producedLotRows[0] as { n: number } | undefined)?.n ?? 0)
    + Number((consumedLotRows[0] as { n: number } | undefined)?.n ?? 0)
  if (purchases > 0 || lots > 0) {
    const reasons = [
      purchases > 0 ? `${purchases} compra(s)` : null,
      lots > 0 ? `${lots} lote(s)` : null
    ].filter(Boolean).join(' e ')
    throw new Error(`Não é possível remover: este item possui ${reasons}. Remova primeiro esses registros históricos.`)
  }
  await db.batch([
    { sql: 'DELETE FROM composition_stock_moves WHERE item_id = ?', parameters: [id] },
    { sql: 'DELETE FROM composition_parts WHERE child_item_id = ?', parameters: [id] },
    { sql: 'DELETE FROM composition_kit_sizes WHERE kit_item_id = ?', parameters: [id] },
    { sql: 'DELETE FROM composition_items WHERE id = ?', parameters: [id] }
  ])
}

async function assertNoCycle(parentId: number, childId: number): Promise<void> {
  if (parentId === childId) throw new Error('Um item não pode conter a si mesmo.')
  const statement = await getAsyncDb().prepare(
    'SELECT parent_item_id, child_item_id FROM composition_parts'
  )
  const rows = (await statement.all([])) as { parent_item_id: number; child_item_id: number }[]
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const list = children.get(row.parent_item_id) ?? []
    list.push(row.child_item_id)
    children.set(row.parent_item_id, list)
  }
  const visits = [childId]
  const seen = new Set<number>()
  while (visits.length > 0) {
    const current = visits.pop()!
    if (current === parentId) throw new Error('Esta ligação criaria um ciclo na composição.')
    if (seen.has(current)) continue
    seen.add(current)
    visits.push(...(children.get(current) ?? []))
  }
}

export async function setCompositionPart(input: {
  itemId: number
  componenteId: number
  quantidade: number | null
}): Promise<void> {
  await assertNoCycle(input.itemId, input.componenteId)
  if (input.quantidade !== null) positive(input.quantidade, 'Quantidade')
  const statement = await getAsyncDb().prepare(
    `INSERT INTO composition_parts (parent_item_id, child_item_id, quantity, position)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM composition_parts WHERE parent_item_id = ?))
     ON CONFLICT(parent_item_id, child_item_id) DO UPDATE SET quantity = excluded.quantity`
  )
  await statement.run([input.itemId, input.componenteId, input.quantidade, input.itemId])
}

export async function removeCompositionPart(id: number): Promise<void> {
  const statement = await getAsyncDb().prepare('DELETE FROM composition_parts WHERE id = ?')
  await statement.run([id])
}

export async function createCompositionVariant(itemId: number, name: string): Promise<number> {
  const statement = await getAsyncDb().prepare(
    'INSERT INTO composition_variants (item_id, name) VALUES (?, ?)'
  )
  return Number((await statement.run([itemId, requiredName(name)])).lastInsertRowid)
}

export async function updateCompositionVariant(id: number, name: string): Promise<void> {
  const statement = await getAsyncDb().prepare('UPDATE composition_variants SET name = ? WHERE id = ?')
  await statement.run([requiredName(name), id])
}

export async function deleteCompositionVariant(id: number): Promise<void> {
  const db = getAsyncDb()
  const count = await db.prepare(
    'SELECT COUNT(*) AS n FROM composition_variants WHERE item_id = (SELECT item_id FROM composition_variants WHERE id = ?)'
  )
  const row = (await count.get([id])) as { n: number }
  if (row.n <= 1) throw new Error('Cada item precisa ter ao menos uma versão.')
  const statement = await db.prepare('DELETE FROM composition_variants WHERE id = ?')
  try {
    await statement.run([id])
  } catch (error) {
    throw new Error('Esta versão possui compras, estoque ou lotes e não pode ser removida.', { cause: error })
  }
}

export async function createCompositionKitSize(input: {
  itemId: number
  totalCaixas: number
  multiplicador: number
}): Promise<void> {
  const statement = await getAsyncDb().prepare(
    'INSERT INTO composition_kit_sizes (kit_item_id, total_units, multiplier) VALUES (?, ?, ?)'
  )
  await statement.run([
    input.itemId,
    positive(input.totalCaixas, 'Total de caixas'),
    positive(input.multiplicador, 'Multiplicador')
  ])
}

export async function updateCompositionKitSize(id: number, input: {
  totalCaixas: number
  multiplicador: number
}): Promise<void> {
  const statement = await getAsyncDb().prepare(
    'UPDATE composition_kit_sizes SET total_units = ?, multiplier = ? WHERE id = ?'
  )
  await statement.run([
    positive(input.totalCaixas, 'Total de caixas'),
    positive(input.multiplicador, 'Multiplicador'),
    id
  ])
}

export async function deleteCompositionKitSize(id: number): Promise<void> {
  const statement = await getAsyncDb().prepare('DELETE FROM composition_kit_sizes WHERE id = ?')
  try {
    await statement.run([id])
  } catch (error) {
    throw new Error('Este tamanho já foi usado em um lote e não pode ser removido.', { cause: error })
  }
}

export async function recordCompositionPurchase(input: {
  itemId: number
  variantId: number | null
  quantidade: number
  valor: number
  frete?: number
  compradoEm?: number
  fornecedor?: string | null
}): Promise<void> {
  await validateVariant(input.itemId, input.variantId)
  const quantity = positive(input.quantidade, 'Quantidade')
  const total = nonNegative(input.valor, 'Valor')
  const shipping = nonNegative(input.frete ?? 0, 'Frete')
  const key = randomUUID()
  const when = input.compradoEm ?? Date.now()
  await getAsyncDb().batch([
    {
      sql: `INSERT INTO composition_purchases
        (operation_key, item_id, variant_id, quantity, total, shipping, bought_at, supplier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parameters: [key, input.itemId, input.variantId, quantity, total, shipping, when,
        input.fornecedor?.trim() || null, Date.now()]
    },
    {
      sql: `INSERT INTO composition_stock_moves
        (item_id, variant_id, quantity, unit_cost, reason, purchase_id, happened_at)
       VALUES (?, ?, ?, ?, 'COMPRA',
        (SELECT id FROM composition_purchases WHERE operation_key = ?), ?)`,
      parameters: [input.itemId, input.variantId, quantity, (total + shipping) / quantity, key, when]
    }
  ])
}

export async function deleteCompositionPurchase(id: number): Promise<void> {
  await getAsyncDb().batch([
    { sql: 'DELETE FROM composition_stock_moves WHERE purchase_id = ?', parameters: [id] },
    { sql: 'DELETE FROM composition_purchases WHERE id = ?', parameters: [id] }
  ])
}

export async function updateCompositionPurchase(id: number, input: {
  itemId: number
  variantId: number | null
  quantidade: number
  valor: number
  frete?: number
  compradoEm?: number
  fornecedor?: string | null
}): Promise<void> {
  await validateVariant(input.itemId, input.variantId)
  const quantity = positive(input.quantidade, 'Quantidade')
  const total = nonNegative(input.valor, 'Valor')
  const shipping = nonNegative(input.frete ?? 0, 'Frete')
  const when = input.compradoEm ?? Date.now()
  await getAsyncDb().batch([
    {
      sql: `UPDATE composition_purchases SET item_id = ?, variant_id = ?, quantity = ?,
        total = ?, shipping = ?, bought_at = ?, supplier = ? WHERE id = ?`,
      parameters: [input.itemId, input.variantId, quantity, total, shipping, when,
        input.fornecedor?.trim() || null, id]
    },
    {
      sql: `UPDATE composition_stock_moves SET item_id = ?, variant_id = ?, quantity = ?,
        unit_cost = ?, happened_at = ? WHERE purchase_id = ?`,
      parameters: [input.itemId, input.variantId, quantity, (total + shipping) / quantity, when, id]
    }
  ])
}

export async function adjustCompositionStock(input: {
  itemId: number
  variantId: number | null
  quantidade: number
  observacao?: string | null
}): Promise<void> {
  await validateVariant(input.itemId, input.variantId)
  if (!Number.isFinite(input.quantidade) || input.quantidade === 0) {
    throw new Error('O ajuste deve ser diferente de zero.')
  }
  const statement = await getAsyncDb().prepare(
    `INSERT INTO composition_stock_moves
      (item_id, variant_id, quantity, reason, happened_at, notes)
     VALUES (?, ?, ?, 'AJUSTE', ?, ?)`
  )
  await statement.run([
    input.itemId, input.variantId, input.quantidade, Date.now(), input.observacao?.trim() || null
  ])
}

export async function previewCompositionProduction(itemId: number, quantity: number): Promise<ConsumoProducao[]> {
  positive(quantity, 'Quantidade produzida')
  const core = await loadCore()
  const itemById = new Map(core.itemRows.map((item) => [item.id, item]))
  const partsByParent = new Map<number, PartRow[]>()
  for (const part of core.partRows) {
    const list = partsByParent.get(part.parent_item_id) ?? []
    list.push(part)
    partsByParent.set(part.parent_item_id, list)
  }
  const required = new Map<number, number>()
  const explode = (id: number, multiplier: number, path: number[]): void => {
    if (path.includes(id)) throw new Error('A composição contém um ciclo.')
    const parts = partsByParent.get(id) ?? []
    if (parts.length === 0) {
      required.set(id, (required.get(id) ?? 0) + multiplier)
      return
    }
    for (const part of parts) {
      if (part.quantity === null) {
        const parent = itemById.get(id)
        const child = itemById.get(part.child_item_id)
        throw new Error(`Informe a quantidade de ${child?.name ?? 'um componente'} em ${parent?.name ?? 'esta composição'} antes de produzir.`)
      }
      explode(part.child_item_id, multiplier * part.quantity, [...path, id])
    }
  }
  explode(itemId, quantity, [])
  return [...required].map(([id, amount]) => {
    const item = itemById.get(id)!
    const variants = core.variantRows.filter((variant) => variant.item_id === id)
    const preferred = [...variants].sort((a, b) => b.stock - a.stock)[0]
    const unitCost = preferred?.average_cost ?? core.averageByItem.get(id) ?? item.reference_cost
    return {
      itemId: id,
      itemNome: item.name,
      unidade: item.unit,
      varianteId: preferred?.id ?? null,
      quantidade: round(amount, 3),
      estoque: round(variants.reduce((sum, variant) => sum + variant.stock, 0), 3),
      custoUnitario: unitCost ?? null,
      custoTotal: unitCost === null || unitCost === undefined ? null : round(unitCost * amount)
    }
  }).sort((a, b) => a.itemNome.localeCompare(b.itemNome, 'pt-BR'))
}

export async function createCompositionProductionLot(input: {
  itemId: number
  variantId?: number | null
  kitSizeId?: number | null
  quantidade: number
  produzidoEm?: number
  observacao?: string | null
  consumos: { itemId: number; variantId: number | null; quantidade: number }[]
}): Promise<void> {
  const quantity = positive(input.quantidade, 'Quantidade produzida')
  if (input.consumos.length === 0) throw new Error('Informe ao menos um material consumido.')
  const summary = await compositionSummary()
  const target = summary.itens.find((item) => item.id === input.itemId)
  if (!target) throw new Error('Item produzido não encontrado.')
  const targetVariantId = input.variantId ?? target.variantes[0]?.id ?? null
  await validateVariant(input.itemId, targetVariantId)
  const kitSize = input.kitSizeId === null || input.kitSizeId === undefined
    ? null
    : summary.tamanhosKit.find((size) => size.id === input.kitSizeId && size.kitItemId === input.itemId)
  if (input.kitSizeId && !kitSize) throw new Error('O tamanho selecionado não pertence a este kit.')
  if (target.tipo === 'KIT' && !kitSize) throw new Error('Selecione o tamanho do kit produzido.')
  const core = await loadCore()
  const itemById = new Map(core.itemRows.map((item) => [item.id, item]))
  const variantById = new Map(core.variantRows.map((variant) => [variant.id, variant]))
  const normalized = input.consumos.map((consumption) => {
    const item = itemById.get(consumption.itemId)
    if (!item) throw new Error('Material consumido não encontrado.')
    const amount = positive(consumption.quantidade, `Quantidade de ${item.name}`)
    const variant = consumption.variantId === null ? undefined : variantById.get(consumption.variantId)
    if (variant && variant.item_id !== item.id) throw new Error('A variante não pertence ao material informado.')
    const unitCost = variant?.average_cost ?? core.averageByItem.get(item.id) ?? item.reference_cost
    if (unitCost === null || unitCost === undefined) {
      throw new Error(`Cadastre uma compra ou custo de referência para ${item.name} antes de produzir.`)
    }
    return { ...consumption, quantidade: amount, unitCost, totalCost: round(unitCost * amount) }
  })
  const actualTotal = round(normalized.reduce((sum, item) => sum + item.totalCost, 0))
  const estimatedUnit = (target.custoEstimado ?? 0) * (kitSize?.multiplicador ?? 1)
  const key = randomUUID()
  const producedAt = input.produzidoEm ?? Date.now()
  const statements: { sql: string; parameters: unknown[] }[] = [{
    sql: `INSERT INTO composition_production_lots
      (operation_key, item_id, variant_id, kit_size_id, quantity, estimated_unit_cost, actual_total_cost, produced_at, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    parameters: [key, input.itemId, targetVariantId, kitSize?.id ?? null, quantity, estimatedUnit, actualTotal, producedAt,
      input.observacao?.trim() || null, Date.now()]
  }]
  for (const consumption of normalized) {
    statements.push({
      sql: `INSERT INTO composition_lot_consumptions
        (lot_id, item_id, variant_id, quantity, unit_cost, total_cost)
       VALUES ((SELECT id FROM composition_production_lots WHERE operation_key = ?), ?, ?, ?, ?, ?)`,
      parameters: [key, consumption.itemId, consumption.variantId, consumption.quantidade,
        consumption.unitCost, consumption.totalCost]
    })
    statements.push({
      sql: `INSERT INTO composition_stock_moves
        (item_id, variant_id, quantity, unit_cost, reason, lot_id, happened_at)
       VALUES (?, ?, ?, ?, 'PRODUCAO_CONSUMO',
        (SELECT id FROM composition_production_lots WHERE operation_key = ?), ?)`,
      parameters: [consumption.itemId, consumption.variantId, -consumption.quantidade,
        consumption.unitCost, key, producedAt]
    })
  }
  if (target.controlaEstoque) {
    statements.push({
      sql: `INSERT INTO composition_stock_moves
        (item_id, variant_id, quantity, unit_cost, reason, lot_id, happened_at)
       VALUES (?, ?, ?, ?, 'PRODUCAO_ENTRADA',
        (SELECT id FROM composition_production_lots WHERE operation_key = ?), ?)`,
      parameters: [input.itemId, targetVariantId, quantity, actualTotal / quantity, key, producedAt]
    })
  }
  await getAsyncDb().batch(statements)
}
