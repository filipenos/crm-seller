import { getAsyncDb } from '../db'
import type {
  ConsumoInsumo,
  CustoPedido,
  ItemReceita,
  LinhaFabricacao,
  Receita,
  TipoReceita
} from '@shared/types'

/**
 * Receitas: o que é preciso para fazer cada coisa.
 *
 * Uma receita pede insumos e **outras receitas** — o laço é uma receita, e a
 * caixa milk pede um laço. Isso evita repetir cetim e meia pérola em cada caixa
 * que leva laço, e faz o custo do laço subir sozinho em todas elas quando o
 * cetim encarece.
 *
 * As receitas de caixa se juntam numa **linha de fabricação**, e o produto
 * aponta para a linha. É assim que "estas caixas se fazem assim, aquelas de
 * outro jeito" fica dizível sem duplicar o cadastro inteiro.
 *
 * O kit vendido não é cadastrado: a variação da Shopee já diz o tamanho ("20
 * peças / 4 de cada modelo"), então as caixas de cada modelo saem de dividir as
 * peças pelos modelos da linha.
 */

interface ReceitaRow {
  id: number
  line_id: number | null
  name: string
  kind: string
  yields: number
  position: number
}

interface ItemRow {
  id: number
  recipe_id: number
  supply_id: number | null
  child_recipe_id: number | null
  quantity: number | null
  position: number
}

function arredonda(n: number, casas = 2): number {
  return Number(n.toFixed(casas))
}

let productionSnapshotInFlight: Promise<{
  linhas: LinhaFabricacao[]
  componentes: Receita[]
}> | null = null

async function productionSnapshot(): Promise<{ linhas: LinhaFabricacao[]; componentes: Receita[] }> {
  if (productionSnapshotInFlight) return productionSnapshotInFlight
  productionSnapshotInFlight = (async () => {
    const db = getAsyncDb()
    const [linesStmt, recipesStmt, itemsStmt, costsStmt, productsStmt] = await Promise.all([
      db.prepare('SELECT id, name, is_default FROM production_lines ORDER BY is_default DESC, name'),
      db.prepare('SELECT id, line_id, name, kind, yields, position FROM recipes ORDER BY position, id'),
      db.prepare(`SELECT i.id, i.recipe_id, i.supply_id, i.child_recipe_id, i.quantity, i.position,
        s.name AS supply_name, s.unit AS supply_unit
        FROM recipe_items i LEFT JOIN supplies s ON s.id = i.supply_id ORDER BY i.position, i.id`),
      db.prepare(`SELECT v.supply_id,
        CASE WHEN SUM(p.quantity) > 0 THEN SUM(p.total + p.shipping) / SUM(p.quantity) END AS custo
        FROM supply_variants v LEFT JOIN purchases p ON p.variant_id = v.id GROUP BY v.supply_id`),
      db.prepare('SELECT line_id, COUNT(*) AS n FROM products GROUP BY line_id')
    ])
    const [lines, recipes, items, costs, productCounts] = await Promise.all([
      linesStmt.all([]) as Promise<{ id: number; name: string; is_default: number }[]>,
      recipesStmt.all([]) as Promise<ReceitaRow[]>,
      itemsStmt.all([]) as Promise<(ItemRow & { supply_name: string | null; supply_unit: string | null })[]>,
      costsStmt.all([]) as Promise<{ supply_id: number; custo: number | null }[]>,
      productsStmt.all([]) as Promise<{ line_id: number | null; n: number }[]>
    ])
    const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]))
    const itemsByRecipe = new Map<number, typeof items>()
    for (const item of items) {
      const list = itemsByRecipe.get(item.recipe_id) ?? []
      list.push(item)
      itemsByRecipe.set(item.recipe_id, list)
    }
    const costBySupply = new Map(costs.map((cost) => [cost.supply_id, cost.custo]))
    const cost = (id: number, path: number[] = []): { value: number; uncertain: number } => {
      if (path.includes(id)) return { value: 0, uncertain: 1 }
      let value = 0
      let uncertain = 0
      for (const item of itemsByRecipe.get(id) ?? []) {
        if (item.quantity === null) { uncertain++; continue }
        if (item.supply_id !== null) {
          const unit = costBySupply.get(item.supply_id)
          if (unit === null || unit === undefined) uncertain++
          else value += unit * item.quantity
        } else if (item.child_recipe_id !== null) {
          const child = recipeById.get(item.child_recipe_id)
          const nested = cost(item.child_recipe_id, [...path, id])
          value += nested.value / Math.max(1, child?.yields ?? 1) * item.quantity
          uncertain += nested.uncertain
        }
      }
      return { value, uncertain }
    }
    const build = (row: ReceitaRow): Receita => {
      const calculated = cost(row.id)
      return {
        id: row.id, linhaId: row.line_id, nome: row.name, tipo: row.kind as TipoReceita,
        rende: row.yields, custo: arredonda(calculated.value, 4), incertos: calculated.uncertain,
        itens: (itemsByRecipe.get(row.id) ?? []).map((item) => {
          const child = item.child_recipe_id === null ? undefined : recipeById.get(item.child_recipe_id)
          let itemCost: number | null = null
          if (item.quantity !== null && item.supply_id !== null) {
            const unit = costBySupply.get(item.supply_id)
            itemCost = unit === null || unit === undefined ? null : arredonda(unit * item.quantity, 4)
          } else if (item.quantity !== null && child) {
            itemCost = arredonda(cost(child.id, [row.id]).value / Math.max(1, child.yields) * item.quantity, 4)
          }
          return {
            id: item.id, insumoId: item.supply_id, insumoNome: item.supply_name,
            unidade: item.supply_unit, receitaFilhaId: item.child_recipe_id,
            receitaFilhaNome: child?.name ?? null, quantidade: item.quantity, custo: itemCost
          }
        })
      }
    }
    const builtById = new Map(recipes.map((recipe) => [recipe.id, build(recipe)]))
    const nullProducts = productCounts.find((entry) => entry.line_id === null)?.n ?? 0
    return {
      componentes: recipes.filter((recipe) => recipe.line_id === null).map((recipe) => builtById.get(recipe.id)!),
      linhas: lines.map((line) => {
        const lineRecipes = recipes.filter((recipe) => recipe.line_id === line.id).map((recipe) => builtById.get(recipe.id)!)
        const boxes = lineRecipes.filter((recipe) => recipe.tipo === 'CAIXA')
        const assigned = productCounts.find((entry) => entry.line_id === line.id)?.n ?? 0
        return {
          id: line.id, nome: line.name, padrao: line.is_default === 1, receitas: lineRecipes,
          produtos: assigned + (line.is_default === 1 ? nullProducts : 0),
          custoPorCaixa: boxes.length
            ? arredonda(boxes.reduce((sum, recipe) => sum + recipe.custo, 0) / boxes.length, 4)
            : 0
        }
      })
    }
  })()
  try {
    return await productionSnapshotInFlight
  } finally {
    productionSnapshotInFlight = null
  }
}

export async function listarLinhasAsync(): Promise<LinhaFabricacao[]> {
  return (await productionSnapshot()).linhas
}

export async function listarComponentesAsync(): Promise<Receita[]> {
  return (await productionSnapshot()).componentes
}

type Consumo = Map<number, number>
/**
 * Desde quando o estoque conta as saídas.
 *
 * Sem um marco, a primeira baixa desceria sobre os mais de 500 pedidos já
 * despachados e o estoque nasceria centenas de folhas negativo — consumo que
 * aconteceu de verdade, mas num tempo em que nenhuma compra foi registrada. O
 * marco é gravado na primeira vez que isto roda: o que veio antes é história,
 * não saída de estoque.
 */
export async function estoqueDesdeAsync(): Promise<number> {
  const db = getAsyncDb()
  const select = await db.prepare("SELECT value FROM settings WHERE key = 'estoqueDesde'")
  const row = (await select.get([])) as { value: string } | undefined
  if (row) return Number(JSON.parse(row.value))
  const now = Date.now()
  const insert = await db.prepare(
    "INSERT INTO settings (key, value) VALUES ('estoqueDesde', ?) ON CONFLICT(key) DO NOTHING"
  )
  await insert.run([JSON.stringify(now)])
  return now
}

export async function criarLinhaAsync(nome: string): Promise<number> {
  const db = getAsyncDb()
  const countStatement = await db.prepare('SELECT COUNT(*) AS n FROM production_lines')
  const count = (await countStatement.get([])) as { n: number }
  const insert = await db.prepare(
    'INSERT INTO production_lines (name, is_default, created_at) VALUES (?, ?, ?)'
  )
  return Number((await insert.run([nome, count.n > 0 ? 0 : 1, Date.now()])).lastInsertRowid)
}

export async function renomearLinhaAsync(id: number, nome: string): Promise<void> {
  const statement = await getAsyncDb().prepare('UPDATE production_lines SET name = ? WHERE id = ?')
  await statement.run([nome, id])
}

export async function removerLinhaAsync(id: number): Promise<void> {
  const db = getAsyncDb()
  const products = await db.prepare('UPDATE products SET line_id = NULL WHERE line_id = ?')
  const line = await db.prepare('DELETE FROM production_lines WHERE id = ?')
  await products.run([id])
  await line.run([id])
}

export async function criarReceitaAsync(input: {
  linhaId: number | null; nome: string; tipo: TipoReceita; rende?: number
}): Promise<number> {
  const db = getAsyncDb()
  const positionStatement = await db.prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM recipes WHERE line_id IS ?'
  )
  const position = (await positionStatement.get([input.linhaId])) as { p: number }
  const insert = await db.prepare(
    'INSERT INTO recipes (line_id, name, kind, yields, position) VALUES (?, ?, ?, ?, ?)'
  )
  return Number((await insert.run([
    input.linhaId, input.nome, input.tipo, input.rende ?? 1, position.p
  ])).lastInsertRowid)
}

export async function atualizarReceitaAsync(
  id: number,
  input: { nome?: string; rende?: number }
): Promise<void> {
  const db = getAsyncDb()
  if (input.nome !== undefined) {
    const statement = await db.prepare('UPDATE recipes SET name = ? WHERE id = ?')
    await statement.run([input.nome, id])
  }
  if (input.rende !== undefined) {
    const statement = await db.prepare('UPDATE recipes SET yields = ? WHERE id = ?')
    await statement.run([input.rende, id])
  }
}

export async function removerReceitaAsync(id: number): Promise<void> {
  const statement = await getAsyncDb().prepare('DELETE FROM recipes WHERE id = ?')
  await statement.run([id])
}

export async function adicionarItemAsync(input: {
  receitaId: number; insumoId?: number | null; receitaFilhaId?: number | null;
  quantidade: number | null
}): Promise<number> {
  const db = getAsyncDb()
  const positionStatement = await db.prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM recipe_items WHERE recipe_id = ?'
  )
  const position = (await positionStatement.get([input.receitaId])) as { p: number }
  const insert = await db.prepare(
    'INSERT INTO recipe_items (recipe_id, supply_id, child_recipe_id, quantity, position) VALUES (?, ?, ?, ?, ?)'
  )
  return Number((await insert.run([
    input.receitaId, input.insumoId ?? null, input.receitaFilhaId ?? null,
    input.quantidade, position.p
  ])).lastInsertRowid)
}

export async function atualizarItemAsync(id: number, quantidade: number | null): Promise<void> {
  const statement = await getAsyncDb().prepare('UPDATE recipe_items SET quantity = ? WHERE id = ?')
  await statement.run([quantidade, id])
}

export async function removerItemAsync(id: number): Promise<void> {
  const statement = await getAsyncDb().prepare('DELETE FROM recipe_items WHERE id = ?')
  await statement.run([id])
}

/**
 * Baixa o estoque dos pedidos que já foram postados.
 *
 * Roda a cada sincronização, sobre todos os despachados — a idempotência vem do
 * `ref` único por pedido e variante, não de lembrar onde parou. Assim um pedido
 * que só depois ganha rastreio também é descontado, e nada é descontado duas
 * vezes.
 */
export async function consumoDoPedidoAsync(orderSn: string): Promise<CustoPedido> {
  const db = getAsyncDb()
  const [orderItemsStmt, defaultLineStmt, productsStmt, recipesStmt, itemsStmt, suppliesStmt] =
    await Promise.all([
      db.prepare('SELECT item_id, quantity, pecas FROM order_items WHERE order_sn = ?'),
      db.prepare('SELECT id FROM production_lines ORDER BY is_default DESC, id LIMIT 1'),
      db.prepare('SELECT item_id, line_id FROM products'),
      db.prepare('SELECT id, line_id, kind, yields FROM recipes'),
      db.prepare('SELECT recipe_id, supply_id, child_recipe_id, quantity FROM recipe_items'),
      db.prepare(`SELECT s.id, s.name, s.unit,
        CASE WHEN SUM(p.quantity) > 0 THEN SUM(p.total + p.shipping) / SUM(p.quantity) END AS custo,
        (SELECT COALESCE(SUM(m.quantity), 0) FROM stock_moves m
          JOIN supply_variants sv ON sv.id = m.variant_id WHERE sv.supply_id = s.id) AS estoque
        FROM supplies s LEFT JOIN supply_variants v ON v.supply_id = s.id
        LEFT JOIN purchases p ON p.variant_id = v.id GROUP BY s.id`)
    ])
  const [orderItems, defaultLine, products, recipes, items, supplies] = await Promise.all([
    orderItemsStmt.all([orderSn]) as Promise<{ item_id: string | null; quantity: number; pecas: number | null }[]>,
    defaultLineStmt.get([]) as Promise<{ id: number } | undefined>,
    productsStmt.all([]) as Promise<{ item_id: string; line_id: number | null }[]>,
    recipesStmt.all([]) as Promise<{ id: number; line_id: number | null; kind: string; yields: number }[]>,
    itemsStmt.all([]) as Promise<{ recipe_id: number; supply_id: number | null; child_recipe_id: number | null; quantity: number | null }[]>,
    suppliesStmt.all([]) as Promise<{ id: number; name: string; unit: string; custo: number | null; estoque: number }[]>
  ])
  const lineByProduct = new Map(products.map((product) => [product.item_id, product.line_id]))
  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]))
  const itemsByRecipe = new Map<number, typeof items>()
  for (const item of items) {
    const list = itemsByRecipe.get(item.recipe_id) ?? []
    list.push(item)
    itemsByRecipe.set(item.recipe_id, list)
  }
  const consumed = new Map<number, number>()
  const explode = (recipeId: number, times: number, path: number[] = []): void => {
    if (path.includes(recipeId) || times <= 0) return
    for (const item of itemsByRecipe.get(recipeId) ?? []) {
      if (item.quantity === null) continue
      if (item.supply_id !== null) {
        consumed.set(item.supply_id, (consumed.get(item.supply_id) ?? 0) + item.quantity * times)
      } else if (item.child_recipe_id !== null) {
        const child = recipeById.get(item.child_recipe_id)
        explode(item.child_recipe_id, item.quantity * times / Math.max(1, child?.yields ?? 1), [...path, recipeId])
      }
    }
  }
  let incomplete = false
  let orderLine: number | null = null
  for (const item of orderItems) {
    const lineId = (item.item_id ? lineByProduct.get(item.item_id) : null) ?? defaultLine?.id ?? null
    if (lineId === null) { incomplete = true; continue }
    orderLine ??= lineId
    const boxes = recipes.filter((recipe) => recipe.line_id === lineId && recipe.kind === 'CAIXA')
    if (boxes.length === 0 || !item.pecas) { incomplete = true; continue }
    for (const box of boxes) explode(box.id, item.pecas * item.quantity / boxes.length)
  }
  if (orderLine !== null) {
    for (const packaging of recipes.filter(
      (recipe) => recipe.line_id === orderLine && recipe.kind === 'EMBALAGEM'
    )) explode(packaging.id, 1)
  }
  const supplyById = new Map(supplies.map((supply) => [supply.id, supply]))
  let total = 0
  const result: ConsumoInsumo[] = []
  for (const [supplyId, quantity] of consumed) {
    const supply = supplyById.get(supplyId)
    if (!supply) continue
    if (supply.custo === null) incomplete = true
    else total += supply.custo * quantity
    result.push({
      insumoId: supplyId, insumoNome: supply.name, unidade: supply.unit,
      quantidade: arredonda(quantity, 3),
      custo: supply.custo === null ? null : arredonda(supply.custo * quantity, 4),
      estoque: arredonda(supply.estoque)
    })
  }
  result.sort((a, b) => a.insumoNome.localeCompare(b.insumoNome))
  return { orderSn, custo: arredonda(total), incompleto: incomplete, insumos: result }
}

export async function baixarEstoqueDosDespachadosAsync(): Promise<{
  pedidos: number; movimentos: number
}> {
  const db = getAsyncDb()
  const since = await estoqueDesdeAsync()
  const select = await db.prepare(
    `SELECT DISTINCT e.order_sn FROM order_events e
      WHERE e.source = 'logistics' AND LOWER(e.description) LIKE '%postado%'
        AND e.happened_at >= ? AND NOT EXISTS (
          SELECT 1 FROM stock_moves m WHERE m.order_sn = e.order_sn AND m.reason = 'pedido')`
  )
  const dispatched = (await select.all([since])) as { order_sn: string }[]
  let orders = 0
  let moves = 0
  for (const { order_sn: orderSn } of dispatched) {
    const consumption = await consumoDoPedidoAsync(orderSn)
    if (consumption.insumos.length === 0) continue
    for (const supply of consumption.insumos) {
      const variantStatement = await db.prepare(
        `SELECT v.id, (SELECT COALESCE(SUM(m.quantity), 0) FROM stock_moves m
          WHERE m.variant_id = v.id) AS estoque FROM supply_variants v
          WHERE v.supply_id = ? ORDER BY estoque DESC, v.id ASC LIMIT 1`
      )
      const variant = (await variantStatement.get([supply.insumoId])) as { id: number } | undefined
      if (!variant) continue
      const insert = await db.prepare(
        `INSERT OR IGNORE INTO stock_moves
          (variant_id, quantity, reason, ref, order_sn, happened_at)
         VALUES (?, ?, 'pedido', ?, ?, ?)`
      )
      const result = await insert.run([
        variant.id, -supply.quantidade, `pedido:${orderSn}:${variant.id}`, orderSn, Date.now()
      ])
      moves += result.changes
    }
    orders++
  }
  return { pedidos: orders, movimentos: moves }
}
