import { getDb } from '../db'
import type { Produto } from '@shared/types'
import { custoPorCaixaDoProduto } from './receitas'

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
export function recomporCatalogoDosPedidos(): { produtos: number; variacoes: number } {
  const db = getDb()
  const recompor = db.transaction(() => {
    const produtos = db
      .prepare(
        `INSERT INTO products (item_id, name, image_url)
         SELECT i.item_id, i.item_name, MAX(i.image_url)
           FROM order_items i
          WHERE i.item_id IS NOT NULL
          GROUP BY i.item_id, i.item_name
         ON CONFLICT(item_id) DO UPDATE SET
           name = COALESCE(products.name, excluded.name),
           image_url = COALESCE(products.image_url, excluded.image_url)`
      )
      .run()

    const variacoes = db
      .prepare(
        `INSERT INTO product_variations (model_id, item_id, name, pecas)
         SELECT i.model_id, MAX(i.item_id), MAX(i.model_name), MAX(i.pecas)
           FROM order_items i
          WHERE i.model_id IS NOT NULL AND i.item_id IS NOT NULL
          GROUP BY i.model_id
         ON CONFLICT(model_id) DO UPDATE SET
           name = COALESCE(product_variations.name, excluded.name),
           pecas = COALESCE(product_variations.pecas, excluded.pecas)`
      )
      .run()

    return { produtos: produtos.changes, variacoes: variacoes.changes }
  })
  return recompor()
}

export function salvarProdutoShopee(p: ProdutoShopee): void {
  const db = getDb()
  const salvar = db.transaction(() => {
    db.prepare(
      `INSERT INTO products (item_id, name, image_url, price, stock, active, synced_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         name = excluded.name,
         image_url = COALESCE(excluded.image_url, products.image_url),
         price = excluded.price,
         stock = excluded.stock,
         active = excluded.active,
         synced_at = excluded.synced_at,
         raw_json = excluded.raw_json`
    ).run(
      p.itemId,
      p.nome,
      p.imagemUrl,
      p.preco,
      p.estoque,
      p.ativo === null ? null : p.ativo ? 1 : 0,
      Date.now(),
      p.rawJson
    )

    for (const v of p.variacoes) {
      db.prepare(
        `INSERT INTO product_variations (model_id, item_id, name, pecas, price, stock)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           item_id = excluded.item_id,
           name = COALESCE(excluded.name, product_variations.name),
           price = excluded.price,
           stock = excluded.stock`
      ).run(v.modelId, p.itemId, v.nome, pecasDaVariacao(v.nome), v.preco, v.estoque)
    }
  })
  salvar()
}

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
  linha: string | null
  synced_at: number | null
  variacoes: number
  pedidos: number
  caixas: number | null
  vendas: number | null
  ultimo: number | null
}

export function listarProdutos(): Produto[] {
  const rows = getDb()
    .prepare(
      `SELECT p.*,
              l.name AS linha,
              (SELECT COUNT(*) FROM product_variations v WHERE v.item_id = p.item_id) AS variacoes,
              (SELECT COUNT(DISTINCT i.order_sn) FROM order_items i
                 JOIN orders o ON o.order_sn = i.order_sn
                WHERE i.item_id = p.item_id AND o.tab != 'CANCELADO') AS pedidos,
              (SELECT SUM(i.pecas * i.quantity) FROM order_items i
                 JOIN orders o ON o.order_sn = i.order_sn
                WHERE i.item_id = p.item_id AND o.tab != 'CANCELADO') AS caixas,
              (SELECT SUM(o.total_amount) FROM order_items i
                 JOIN orders o ON o.order_sn = i.order_sn
                WHERE i.item_id = p.item_id AND o.tab != 'CANCELADO') AS vendas,
              (SELECT MAX(o.created_at_shopee) FROM order_items i
                 JOIN orders o ON o.order_sn = i.order_sn
                WHERE i.item_id = p.item_id AND o.tab != 'CANCELADO') AS ultimo
         FROM products p
         LEFT JOIN production_lines l ON l.id = p.line_id
        ORDER BY pedidos DESC, p.name`
    )
    .all() as ProdutoRow[]

  return rows.map((r) => ({
    itemId: r.item_id,
    nome: r.name,
    imagemUrl: r.image_url,
    preco: r.price,
    estoqueShopee: r.stock,
    ativo: r.active === null ? null : r.active === 1,
    linhaId: r.line_id,
    linhaNome: r.linha,
    sincronizadoEm: r.synced_at,
    variacoes: r.variacoes,
    pedidos: r.pedidos,
    caixasVendidas: r.caixas ?? 0,
    vendas: Number((r.vendas ?? 0).toFixed(2)),
    ultimoPedidoEm: r.ultimo,
    custoPorCaixa: custoPorCaixaDoProduto(r.item_id)
  }))
}

export function definirLinhaDoProduto(itemId: string, linhaId: number | null): void {
  getDb().prepare('UPDATE products SET line_id = ? WHERE item_id = ?').run(linhaId, itemId)
}
