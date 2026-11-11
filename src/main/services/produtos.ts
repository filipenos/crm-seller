import { getAsyncDb } from '../db'
import { PRODUCT_SALES_SQL } from '@shared/dashboardDays'
import type { ProductKind, Produto, ProdutoVariacao } from '@shared/types'
import { inferProductKind, parseBowVariation } from '@shared/productVariation'

/**
 * Catálogo de produtos.
 *
 * O catálogo não depende de sincronizar nada: todo item de pedido carrega o
 * `item_id` e o `model_id` da Shopee, então os produtos que já venderam podem
 * ser reconstruídos da base local, sem uma requisição. Sincronizar só acrescenta
 * o que os pedidos não sabem — preço de hoje, estoque anunciado, produto ativo
 * que ainda não vendeu.
 */

export interface ProdutoShopee {
  itemId: string
  nome: string
  imagemUrl: string | null
  preco: number | null
  estoque: number | null
  ativo: boolean | null
  rawJson: string
  variacoes: { modelId: string; nome: string | null; preco: number | null; estoque: number | null }[]
}

/**
 * Reconstrói o catálogo a partir dos pedidos.
 *
 * Só preenche o que está vazio: o que veio da sincronização é mais atual que a
 * memória de um pedido antigo, e um produto renomeado na Shopee não deve voltar
 * ao nome de um ano atrás.
 */
/** O mesmo formato de variação dos pedidos: "20 peças / 4 de cada modelo". */
function pecasDaVariacao(nome: string | null): number | null {
  if (!nome) return null
  const m = /(\d+)\s*(pe[çc]as?|unidades?|un\b)/i.exec(nome)
  return m ? Number(m[1]) : null
}

interface ProdutoRow {
  item_id: string
  name: string
  image_url: string | null
  price: number | null
  stock: number | null
  active: number | null
  line_id: number | null
  kind: ProductKind
  linha: string | null
  synced_at: number | null
  variacoes: number
  pedidos: number
  caixas: number | null
  lacos: number | null
  kits: number | null
  vendas: number | null
  liquido: number | null
  sem_liquido: number
  sem_rateio: number
  ultimo: number | null
}

/** Lista e calcula custos em lote, sem o N+1 da implementação legada. */
export async function listarProdutosAsync(): Promise<Produto[]> {
  const db = getAsyncDb()
  const [rawRows, rawRecipes, rawItems, rawCosts, rawDefaultLine, rawVariations] = await db.queryBatch([
    { sql: `WITH por_pedido AS (
      SELECT i.item_id, i.order_sn, SUM(i.quantity) AS kits,
             SUM(COALESCE(i.pecas, 0) * i.quantity) AS caixas,
             SUM(COALESCE(i.lacos, 0) * i.quantity) AS lacos
        FROM order_items i JOIN orders o ON o.order_sn = i.order_sn
       WHERE i.item_id IS NOT NULL AND o.tab NOT IN ('CANCELADO', 'NAO_PAGO')
       GROUP BY i.item_id, i.order_sn
    ), itens_por_pedido AS (
      SELECT order_sn, COUNT(DISTINCT COALESCE(item_id, 'sem-id:' || id)) AS produtos
        FROM order_items GROUP BY order_sn
    ), vendas AS (
      SELECT v.item_id, COUNT(*) AS pedidos, SUM(v.kits) AS kits,
             SUM(v.caixas) AS caixas, SUM(v.lacos) AS lacos,
             SUM(CASE WHEN n.produtos = 1 THEN ${PRODUCT_SALES_SQL} ELSE 0 END) AS vendas,
             SUM(CASE WHEN n.produtos = 1 THEN i.valor_recebido ELSE 0 END) AS liquido,
             SUM(CASE WHEN n.produtos = 1 AND i.valor_recebido IS NULL THEN 1 ELSE 0 END) AS sem_liquido,
             SUM(CASE WHEN n.produtos > 1 THEN 1 ELSE 0 END) AS sem_rateio,
             MAX(o.created_at_shopee) AS ultimo
        FROM por_pedido v JOIN orders o ON o.order_sn = v.order_sn
        JOIN itens_por_pedido n ON n.order_sn = v.order_sn
        LEFT JOIN order_income i ON i.order_sn = v.order_sn
       GROUP BY v.item_id
    ), variacoes AS (
      SELECT item_id, COUNT(*) AS variacoes FROM product_variations GROUP BY item_id
    )
    SELECT p.item_id, p.name, p.kind, p.image_url, p.price, p.stock, p.active, p.line_id,
           l.name AS linha, p.synced_at, COALESCE(vr.variacoes, 0) AS variacoes,
           COALESCE(v.pedidos, 0) AS pedidos, v.kits, v.caixas, v.lacos,
           v.vendas, v.liquido, COALESCE(v.sem_liquido, 0) AS sem_liquido,
           COALESCE(v.sem_rateio, 0) AS sem_rateio, v.ultimo
      FROM products p LEFT JOIN production_lines l ON l.id = p.line_id
      LEFT JOIN vendas v ON v.item_id = p.item_id
      LEFT JOIN variacoes vr ON vr.item_id = p.item_id
     ORDER BY pedidos DESC, p.name` },
    { sql: 'SELECT id, line_id, kind, yields FROM recipes' },
    { sql: 'SELECT recipe_id, supply_id, child_recipe_id, quantity FROM recipe_items' },
    { sql: `SELECT v.supply_id,
      CASE WHEN SUM(p.quantity) > 0 THEN SUM(p.total + p.shipping) / SUM(p.quantity) END AS custo
      FROM supply_variants v LEFT JOIN purchases p ON p.variant_id = v.id GROUP BY v.supply_id` },
    { sql: 'SELECT id FROM production_lines ORDER BY is_default DESC, id LIMIT 1' },
    { sql: `SELECT v.item_id, v.model_id, v.name,
      COALESCE(SUM(CASE WHEN o.order_sn IS NOT NULL THEN i.quantity ELSE 0 END), 0) AS kits,
      COALESCE(SUM(CASE WHEN o.order_sn IS NOT NULL THEN COALESCE(i.lacos, 0) * i.quantity ELSE 0 END), 0) AS lacos
      FROM product_variations v JOIN products p ON p.item_id = v.item_id AND p.kind = 'LACOS'
      LEFT JOIN order_items i ON i.model_id = v.model_id
      LEFT JOIN orders o ON o.order_sn = i.order_sn AND o.tab NOT IN ('CANCELADO', 'NAO_PAGO')
      GROUP BY v.model_id ORDER BY kits DESC, v.name` }
  ])
  const rows = rawRows as ProdutoRow[]
  const recipes = rawRecipes as { id: number; line_id: number | null; kind: string; yields: number }[]
  const items = rawItems as {
      recipe_id: number; supply_id: number | null; child_recipe_id: number | null; quantity: number | null
    }[]
  const costs = rawCosts as { supply_id: number; custo: number | null }[]
  const defaultLine = rawDefaultLine[0] as { id: number } | undefined
  const variations = rawVariations as { item_id: string; model_id: string; name: string | null; kits: number; lacos: number }[]

  const variationsByItem = new Map<string, ProdutoVariacao[]>()
  for (const variation of variations) {
    const parsed = parseBowVariation(variation.name)
    const list = variationsByItem.get(variation.item_id) ?? []
    list.push({
      modelId: variation.model_id, nome: variation.name,
      cor: parsed?.color ?? null, quantidadePorKit: parsed?.size ?? null,
      kitsVendidos: variation.kits, lacosVendidos: variation.lacos
    })
    variationsByItem.set(variation.item_id, list)
  }

  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]))
  const itemsByRecipe = new Map<number, typeof items>()
  for (const item of items) {
    const list = itemsByRecipe.get(item.recipe_id) ?? []
    list.push(item)
    itemsByRecipe.set(item.recipe_id, list)
  }
  const costBySupply = new Map(costs.map((cost) => [cost.supply_id, cost.custo]))
  const recipeCost = (id: number, path: number[] = []): number => {
    if (path.includes(id)) return 0
    let total = 0
    for (const item of itemsByRecipe.get(id) ?? []) {
      if (item.quantity === null) continue
      if (item.supply_id !== null) total += (costBySupply.get(item.supply_id) ?? 0) * item.quantity
      else if (item.child_recipe_id !== null) {
        const child = recipeById.get(item.child_recipe_id)
        total += recipeCost(item.child_recipe_id, [...path, id]) / Math.max(1, child?.yields ?? 1) * item.quantity
      }
    }
    return total
  }
  const productCost = (lineId: number | null): number | null => {
    const resolved = lineId ?? defaultLine?.id ?? null
    if (resolved === null) return null
    const boxes = recipes.filter((recipe) => recipe.line_id === resolved && recipe.kind === 'CAIXA')
    if (boxes.length === 0) return null
    return Number((boxes.reduce((sum, box) => sum + recipeCost(box.id), 0) / boxes.length).toFixed(4))
  }

  return rows.map((r) => ({
    itemId: r.item_id, nome: r.name, tipo: r.kind, imagemUrl: r.image_url, preco: r.price,
    estoqueShopee: r.stock, ativo: r.active === null ? null : r.active === 1,
    linhaId: r.line_id, linhaNome: r.linha, sincronizadoEm: r.synced_at,
    variacoes: r.variacoes, pedidos: r.pedidos, kitsVendidos: r.kits ?? 0,
    caixasVendidas: r.caixas ?? 0, lacosVendidos: r.lacos ?? 0,
    variacoesDetalhe: variationsByItem.get(r.item_id) ?? [],
    vendas: Number((r.vendas ?? 0).toFixed(2)), liquido: Number((r.liquido ?? 0).toFixed(2)),
    pedidosSemLiquido: r.sem_liquido, pedidosSemRateio: r.sem_rateio,
    ultimoPedidoEm: r.ultimo,
    custoPorCaixa: r.kind === 'CAIXAS' ? productCost(r.line_id) : null
  }))
}

export async function recomporCatalogoDosPedidosAsync(): Promise<{
  produtos: number
  variacoes: number
}> {
  const db = getAsyncDb()
  const results = await db.batch([
    { sql: `INSERT INTO products (item_id, name, image_url, kind)
     SELECT i.item_id, i.item_name, MAX(i.image_url),
       CASE WHEN LOWER(i.item_name) LIKE 'kit laço%' OR LOWER(i.item_name) LIKE 'kit de laço%' THEN 'LACOS' ELSE 'CAIXAS' END
       FROM order_items i
      WHERE i.item_id IS NOT NULL GROUP BY i.item_id, i.item_name
     ON CONFLICT(item_id) DO UPDATE SET name = COALESCE(products.name, excluded.name),
       image_url = COALESCE(products.image_url, excluded.image_url)` },
    { sql: `INSERT INTO product_variations (model_id, item_id, name, pecas)
     SELECT i.model_id, MAX(i.item_id), MAX(i.model_name), MAX(i.pecas) FROM order_items i
      WHERE i.model_id IS NOT NULL AND i.item_id IS NOT NULL GROUP BY i.model_id
     ON CONFLICT(model_id) DO UPDATE SET name = COALESCE(product_variations.name, excluded.name),
       pecas = COALESCE(product_variations.pecas, excluded.pecas)` }
  ])
  return { produtos: results[0].changes, variacoes: results[1].changes }
}

export async function salvarProdutoShopeeAsync(product: ProdutoShopee): Promise<void> {
  const db = getAsyncDb()
  const kind = inferProductKind(product.nome)
  await db.batch([{ sql: `INSERT INTO products (item_id, name, kind, image_url, price, stock, active, synced_at, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET name = excluded.name,
       image_url = COALESCE(excluded.image_url, products.image_url), price = excluded.price,
       stock = excluded.stock, active = excluded.active, synced_at = excluded.synced_at,
       raw_json = excluded.raw_json`, parameters: [
    product.itemId, product.nome, kind, product.imagemUrl, product.preco, product.estoque,
    product.ativo === null ? null : product.ativo ? 1 : 0, Date.now(), product.rawJson
  ] }, ...product.variacoes.map((variation) => ({ sql: `INSERT INTO product_variations (model_id, item_id, name, pecas, price, stock)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(model_id) DO UPDATE SET
       item_id = excluded.item_id, name = COALESCE(excluded.name, product_variations.name),
       price = excluded.price, stock = excluded.stock`, parameters: [
      variation.modelId, product.itemId, variation.nome,
      kind === 'CAIXAS' ? pecasDaVariacao(variation.nome) : null,
      variation.preco, variation.estoque
    ] }))])
}

export async function definirTipoDoProdutoAsync(itemId: string, tipo: ProductKind): Promise<void> {
  if (!['CAIXAS', 'LACOS', 'OUTRO'].includes(tipo)) throw new Error('Tipo de produto inválido')
  const db = getAsyncDb()
  await db.batch([
    { sql: 'UPDATE products SET kind = ? WHERE item_id = ?', parameters: [tipo, itemId] },
    { sql: `UPDATE order_items SET lacos = CASE WHEN ? = 'LACOS' THEN
        CAST(TRIM(SUBSTR(model_name, INSTR(model_name, ',') + 1)) AS INTEGER) ELSE NULL END,
        pecas = CASE WHEN ? = 'LACOS' THEN NULL ELSE pecas END
        WHERE item_id = ? AND model_name IS NOT NULL`, parameters: [tipo, tipo, itemId] }
  ])
}

export async function definirLinhaDoProdutoAsync(
  itemId: string,
  linhaId: number | null
): Promise<void> {
  const statement = await getAsyncDb().prepare('UPDATE products SET line_id = ? WHERE item_id = ?')
  await statement.run([linhaId, itemId])
}
