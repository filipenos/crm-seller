import { getAsyncDb, getDb } from '../db'
import type {
  ConsumoInsumo,
  CustoPedido,
  ItemReceita,
  LinhaFabricacao,
  Receita,
  TipoReceita
} from '@shared/types'
import { custoMedioDoInsumo, estoqueDoInsumo, varianteParaConsumo } from './insumos'

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

// ---------- leitura ----------

function itensDaReceita(recipeId: number): ItemRow[] {
  return getDb()
    .prepare('SELECT * FROM recipe_items WHERE recipe_id = ? ORDER BY position, id')
    .all(recipeId) as ItemRow[]
}

function receitaRow(id: number): ReceitaRow | undefined {
  return getDb().prepare('SELECT * FROM recipes WHERE id = ?').get(id) as ReceitaRow | undefined
}

/**
 * Custo de uma execução da receita.
 *
 * `caminho` guarda a cadeia de receitas em curso: sem isso, uma receita que
 * (por engano de cadastro) pedisse a si mesma travaria o app. Item sem
 * quantidade ("um pouco de cola") ou sem compra registrada não vira custo —
 * vira `incertos`, e é por isso que o total é sempre um piso.
 */
function calculaCusto(id: number, caminho: number[] = []): { custo: number; incertos: number } {
  if (caminho.includes(id)) return { custo: 0, incertos: 1 }
  const receita = receitaRow(id)
  if (!receita) return { custo: 0, incertos: 1 }

  let custo = 0
  let incertos = 0
  for (const item of itensDaReceita(id)) {
    if (item.quantity === null) {
      incertos++
      continue
    }
    if (item.supply_id !== null) {
      const medio = custoMedioDoInsumo(item.supply_id)
      if (medio === null) incertos++
      else custo += medio * item.quantity
    } else if (item.child_recipe_id !== null) {
      const filha = receitaRow(item.child_recipe_id)
      const rende = filha?.yields && filha.yields > 0 ? filha.yields : 1
      const sub = calculaCusto(item.child_recipe_id, [...caminho, id])
      custo += (sub.custo / rende) * item.quantity
      incertos += sub.incertos
    }
  }
  return { custo, incertos }
}

function montaReceita(row: ReceitaRow): Receita {
  const db = getDb()
  const itens: ItemReceita[] = itensDaReceita(row.id).map((item) => {
    const insumo =
      item.supply_id === null
        ? null
        : (db.prepare('SELECT name, unit FROM supplies WHERE id = ?').get(item.supply_id) as
            | { name: string; unit: string }
            | undefined)
    const filha =
      item.child_recipe_id === null
        ? null
        : (db.prepare('SELECT name, yields FROM recipes WHERE id = ?').get(item.child_recipe_id) as
            | { name: string; yields: number }
            | undefined)

    let custo: number | null = null
    if (item.quantity !== null) {
      if (item.supply_id !== null) {
        const medio = custoMedioDoInsumo(item.supply_id)
        custo = medio === null ? null : arredonda(medio * item.quantity, 4)
      } else if (item.child_recipe_id !== null) {
        const rende = filha?.yields && filha.yields > 0 ? filha.yields : 1
        custo = arredonda((calculaCusto(item.child_recipe_id, [row.id]).custo / rende) * item.quantity, 4)
      }
    }

    return {
      id: item.id,
      insumoId: item.supply_id,
      insumoNome: insumo?.name ?? null,
      unidade: insumo?.unit ?? null,
      receitaFilhaId: item.child_recipe_id,
      receitaFilhaNome: filha?.name ?? null,
      quantidade: item.quantity,
      custo
    }
  })

  const { custo, incertos } = calculaCusto(row.id)
  return {
    id: row.id,
    linhaId: row.line_id,
    nome: row.name,
    tipo: row.kind as TipoReceita,
    rende: row.yields,
    itens,
    custo: arredonda(custo, 4),
    incertos
  }
}

export function listarComponentes(): Receita[] {
  const rows = getDb()
    .prepare("SELECT * FROM recipes WHERE line_id IS NULL ORDER BY position, name")
    .all() as ReceitaRow[]
  return rows.map(montaReceita)
}

export function listarLinhas(): LinhaFabricacao[] {
  const db = getDb()
  const linhas = db
    .prepare('SELECT * FROM production_lines ORDER BY is_default DESC, name')
    .all() as { id: number; name: string; is_default: number }[]

  return linhas.map((linha) => {
    const receitas = (
      db.prepare('SELECT * FROM recipes WHERE line_id = ? ORDER BY position, id').all(linha.id) as ReceitaRow[]
    ).map(montaReceita)

    const caixas = receitas.filter((r) => r.tipo === 'CAIXA')
    const produtos = linha.is_default
      ? (db
          .prepare('SELECT COUNT(*) AS n FROM products WHERE line_id IS NULL OR line_id = ?')
          .get(linha.id) as { n: number }).n
      : (db.prepare('SELECT COUNT(*) AS n FROM products WHERE line_id = ?').get(linha.id) as { n: number }).n

    return {
      id: linha.id,
      nome: linha.name,
      padrao: linha.is_default === 1,
      receitas,
      produtos,
      custoPorCaixa: caixas.length
        ? arredonda(caixas.reduce((soma, r) => soma + r.custo, 0) / caixas.length, 4)
        : 0
    }
  })
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

export function linhaPadrao(): number | null {
  const row = getDb()
    .prepare('SELECT id FROM production_lines ORDER BY is_default DESC, id LIMIT 1')
    .get() as { id: number } | undefined
  return row?.id ?? null
}

// ---------- escrita ----------

export function criarLinha(nome: string): number {
  const db = getDb()
  const temPadrao = (db.prepare('SELECT COUNT(*) AS n FROM production_lines').get() as { n: number }).n > 0
  const info = db
    .prepare('INSERT INTO production_lines (name, is_default, created_at) VALUES (?, ?, ?)')
    .run(nome, temPadrao ? 0 : 1, Date.now())
  return Number(info.lastInsertRowid)
}

export function renomearLinha(id: number, nome: string): void {
  getDb().prepare('UPDATE production_lines SET name = ? WHERE id = ?').run(nome, id)
}

export function removerLinha(id: number): void {
  const db = getDb()
  const apagar = db.transaction(() => {
    // Produto órfão volta para a padrão em vez de ficar sem receita nenhuma.
    db.prepare('UPDATE products SET line_id = NULL WHERE line_id = ?').run(id)
    db.prepare('DELETE FROM production_lines WHERE id = ?').run(id)
  })
  apagar()
}

export function criarReceita(input: {
  linhaId: number | null
  nome: string
  tipo: TipoReceita
  rende?: number
}): number {
  const db = getDb()
  const pos = (
    db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM recipes WHERE line_id IS ?').get(input.linhaId) as {
      p: number
    }
  ).p
  const info = db
    .prepare('INSERT INTO recipes (line_id, name, kind, yields, position) VALUES (?, ?, ?, ?, ?)')
    .run(input.linhaId, input.nome, input.tipo, input.rende ?? 1, pos)
  return Number(info.lastInsertRowid)
}

export function atualizarReceita(id: number, input: { nome?: string; rende?: number }): void {
  const db = getDb()
  if (input.nome !== undefined) db.prepare('UPDATE recipes SET name = ? WHERE id = ?').run(input.nome, id)
  if (input.rende !== undefined) db.prepare('UPDATE recipes SET yields = ? WHERE id = ?').run(input.rende, id)
}

export function removerReceita(id: number): void {
  getDb().prepare('DELETE FROM recipes WHERE id = ?').run(id)
}

export function adicionarItem(input: {
  receitaId: number
  insumoId?: number | null
  receitaFilhaId?: number | null
  quantidade: number | null
}): number {
  const db = getDb()
  const pos = (
    db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM recipe_items WHERE recipe_id = ?').get(input.receitaId) as {
      p: number
    }
  ).p
  const info = db
    .prepare(
      'INSERT INTO recipe_items (recipe_id, supply_id, child_recipe_id, quantity, position) VALUES (?, ?, ?, ?, ?)'
    )
    .run(input.receitaId, input.insumoId ?? null, input.receitaFilhaId ?? null, input.quantidade, pos)
  return Number(info.lastInsertRowid)
}

export function atualizarItem(id: number, quantidade: number | null): void {
  getDb().prepare('UPDATE recipe_items SET quantity = ? WHERE id = ?').run(quantidade, id)
}

export function removerItem(id: number): void {
  getDb().prepare('DELETE FROM recipe_items WHERE id = ?').run(id)
}

// ---------- consumo ----------

type Consumo = Map<number, number>

/** Soma no acumulador o que N execuções da receita gastam de cada insumo. */
function explodir(receitaId: number, vezes: number, acc: Consumo, caminho: number[] = []): void {
  if (caminho.includes(receitaId) || vezes <= 0) return
  for (const item of itensDaReceita(receitaId)) {
    if (item.quantity === null) continue
    if (item.supply_id !== null) {
      acc.set(item.supply_id, (acc.get(item.supply_id) ?? 0) + item.quantity * vezes)
    } else if (item.child_recipe_id !== null) {
      const filha = receitaRow(item.child_recipe_id)
      const rende = filha?.yields && filha.yields > 0 ? filha.yields : 1
      explodir(item.child_recipe_id, (item.quantity * vezes) / rende, acc, [...caminho, receitaId])
    }
  }
}

function linhaDoProduto(itemId: string | null): number | null {
  const padrao = linhaPadrao()
  if (!itemId) return padrao
  const row = getDb().prepare('SELECT line_id FROM products WHERE item_id = ?').get(itemId) as
    | { line_id: number | null }
    | undefined
  return row?.line_id ?? padrao
}

function receitasDaLinha(linhaId: number, tipo: TipoReceita): ReceitaRow[] {
  return getDb()
    .prepare('SELECT * FROM recipes WHERE line_id = ? AND kind = ? ORDER BY position, id')
    .all(linhaId, tipo) as ReceitaRow[]
}

/**
 * O que um pedido consome.
 *
 * O kit se reparte igualmente entre os modelos da linha — é o que a variação
 * diz ("20 peças / 4 de cada modelo") e o que dividir peças por modelos
 * reproduz, inclusive se um dia uma linha tiver outro número de modelos. A
 * embalagem entra **uma por pedido**, não por kit.
 */
export function consumoDoPedido(orderSn: string): CustoPedido {
  const db = getDb()
  const itens = db
    .prepare('SELECT item_id, quantity, pecas FROM order_items WHERE order_sn = ?')
    .all(orderSn) as { item_id: string | null; quantity: number; pecas: number | null }[]

  const acc: Consumo = new Map()
  let incompleto = false
  let linhaDoPedido: number | null = null

  for (const item of itens) {
    const linhaId = linhaDoProduto(item.item_id)
    if (linhaId === null) {
      incompleto = true
      continue
    }
    linhaDoPedido ??= linhaId
    const caixas = receitasDaLinha(linhaId, 'CAIXA')
    if (!caixas.length || !item.pecas) {
      incompleto = true
      continue
    }
    const porModelo = (item.pecas / caixas.length) * item.quantity
    for (const caixa of caixas) explodir(caixa.id, porModelo, acc)
  }

  if (linhaDoPedido !== null) {
    for (const emb of receitasDaLinha(linhaDoPedido, 'EMBALAGEM')) explodir(emb.id, 1, acc)
  }

  let custo = 0
  const insumos: ConsumoInsumo[] = []
  for (const [insumoId, quantidade] of acc) {
    const info = db.prepare('SELECT name, unit FROM supplies WHERE id = ?').get(insumoId) as
      | { name: string; unit: string }
      | undefined
    if (!info) continue
    const medio = custoMedioDoInsumo(insumoId)
    if (medio === null) incompleto = true
    else custo += medio * quantidade
    insumos.push({
      insumoId,
      insumoNome: info.name,
      unidade: info.unit,
      quantidade: arredonda(quantidade, 3),
      custo: medio === null ? null : arredonda(medio * quantidade, 4),
      estoque: estoqueDoInsumo(insumoId)
    })
  }
  insumos.sort((a, b) => a.insumoNome.localeCompare(b.insumoNome))

  return { orderSn, custo: arredonda(custo), incompleto, insumos }
}

/** Custo dos insumos de uma caixa do produto — a média dos modelos da linha. */
export function custoPorCaixaDoProduto(itemId: string): number | null {
  const linhaId = linhaDoProduto(itemId)
  if (linhaId === null) return null
  const caixas = receitasDaLinha(linhaId, 'CAIXA')
  if (!caixas.length) return null
  const soma = caixas.reduce((total, r) => total + calculaCusto(r.id).custo, 0)
  return arredonda(soma / caixas.length, 4)
}

/**
 * Desde quando o estoque conta as saídas.
 *
 * Sem um marco, a primeira baixa desceria sobre os mais de 500 pedidos já
 * despachados e o estoque nasceria centenas de folhas negativo — consumo que
 * aconteceu de verdade, mas num tempo em que nenhuma compra foi registrada. O
 * marco é gravado na primeira vez que isto roda: o que veio antes é história,
 * não saída de estoque.
 */
export function estoqueDesde(): number {
  const db = getDb()
  const row = db.prepare("SELECT value FROM settings WHERE key = 'estoqueDesde'").get() as
    | { value: string }
    | undefined
  if (row) return Number(JSON.parse(row.value))
  const agora = Date.now()
  db.prepare("INSERT INTO settings (key, value) VALUES ('estoqueDesde', ?)").run(JSON.stringify(agora))
  return agora
}

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
export function baixarEstoqueDosDespachados(): { pedidos: number; movimentos: number } {
  const db = getDb()
  const despachados = db
    .prepare(
      `SELECT DISTINCT e.order_sn
         FROM order_events e
        WHERE e.source = 'logistics' AND LOWER(e.description) LIKE '%postado%'
          AND e.happened_at >= ?
          AND NOT EXISTS (
            SELECT 1 FROM stock_moves m WHERE m.order_sn = e.order_sn AND m.reason = 'pedido'
          )`
    )
    .all(estoqueDesde()) as { order_sn: string }[]

  let movimentos = 0
  let pedidos = 0
  for (const { order_sn } of despachados) {
    const consumo = consumoDoPedido(order_sn)
    if (!consumo.insumos.length) continue
    const baixar = db.transaction(() => {
      for (const insumo of consumo.insumos) {
        const varianteId = varianteParaConsumo(insumo.insumoId)
        if (varianteId === null) continue
        db.prepare(
          `INSERT OR IGNORE INTO stock_moves (variant_id, quantity, reason, ref, order_sn, happened_at)
           VALUES (?, ?, 'pedido', ?, ?, ?)`
        ).run(varianteId, -insumo.quantidade, `pedido:${order_sn}:${varianteId}`, order_sn, Date.now())
        movimentos++
      }
    })
    baixar()
    pedidos++
  }
  return { pedidos, movimentos }
}
