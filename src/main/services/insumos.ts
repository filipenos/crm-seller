import { getAsyncDb } from '../db'
import type { Compra, Insumo, MovimentoEstoque, Unidade, VarianteInsumo } from '@shared/types'

/**
 * Insumos: o que se compra para fabricar, quanto custou e quanto ainda tem.
 *
 * Duas decisões moldam tudo aqui:
 *
 * **A cor é variante do insumo, não outro insumo.** A receita pede "26cm de
 * fita nº9" sem dizer a cor — quem decide é o tema da caixa. Mas o que se
 * compra e o que acaba é a fita *azul*. Então nome e unidade ficam no insumo,
 * enquanto estoque e preço pago ficam na variante.
 *
 * **Estoque é saldo de movimentos, não um número guardado.** Um contador
 * atualizado a cada evento fica errado no primeiro erro e não sabe explicar-se;
 * a soma dos movimentos sempre diz de onde veio cada unidade.
 */

/** Custo unitário é sempre com frete: 1000 folhas por 300 + 20 saem a 0,32. */
const CUSTO_MEDIO_SQL = `
  (SELECT CASE WHEN SUM(p.quantity) > 0
               THEN SUM(p.total + p.shipping) / SUM(p.quantity) END
     FROM purchases p WHERE p.variant_id = v.id)`

const ESTOQUE_SQL = `
  (SELECT COALESCE(SUM(m.quantity), 0) FROM stock_moves m WHERE m.variant_id = v.id)`

interface VarianteRow {
  id: number
  supply_id: number
  name: string
  estoque: number
  custo_medio: number | null
  compras: number
}

function arredonda(n: number, casas = 2): number {
  return Number(n.toFixed(casas))
}

export async function listarInsumosAsync(): Promise<Insumo[]> {
  const db = getAsyncDb()
  const [suppliesStmt, variantsStmt, totalsStmt] = await Promise.all([
    db.prepare('SELECT id, name, unit, min_stock, notes FROM supplies ORDER BY name COLLATE NOCASE'),
    db.prepare(`SELECT v.id, v.supply_id, v.name, ${ESTOQUE_SQL} AS estoque,
      ${CUSTO_MEDIO_SQL} AS custo_medio,
      (SELECT COUNT(*) FROM purchases p WHERE p.variant_id = v.id) AS compras
      FROM supply_variants v ORDER BY v.name COLLATE NOCASE`),
    db.prepare(`SELECT v.supply_id, SUM(p.total + p.shipping) AS pago, SUM(p.quantity) AS qtd
      FROM supply_variants v LEFT JOIN purchases p ON p.variant_id = v.id GROUP BY v.supply_id`)
  ])
  const [supplies, variants, totals] = await Promise.all([
    suppliesStmt.all([]) as Promise<{ id: number; name: string; unit: string; min_stock: number | null; notes: string | null }[]>,
    variantsStmt.all([]) as Promise<VarianteRow[]>,
    totalsStmt.all([]) as Promise<{ supply_id: number; pago: number | null; qtd: number | null }[]>
  ])
  const bySupply = new Map<number, VarianteInsumo[]>()
  for (const variant of variants) {
    const list = bySupply.get(variant.supply_id) ?? []
    list.push({
      id: variant.id, nome: variant.name, estoque: arredonda(variant.estoque),
      custoMedio: variant.custo_medio === null ? null : arredonda(variant.custo_medio, 4),
      compras: variant.compras
    })
    bySupply.set(variant.supply_id, list)
  }
  const totalBySupply = new Map(totals.map((total) => [total.supply_id, total]))
  return supplies.map((supply) => {
    const variantsForSupply = bySupply.get(supply.id) ?? []
    const stock = arredonda(variantsForSupply.reduce((sum, variant) => sum + variant.estoque, 0))
    const total = totalBySupply.get(supply.id)
    const average = total?.pago && total.qtd ? arredonda(total.pago / total.qtd, 4) : null
    return {
      id: supply.id, nome: supply.name, unidade: supply.unit as Unidade,
      estoqueMinimo: supply.min_stock, observacao: supply.notes, variantes: variantsForSupply,
      estoque: stock, custoMedio: average,
      acabando: variantsForSupply.some((variant) => variant.compras > 0) &&
        supply.min_stock !== null && stock <= supply.min_stock
    }
  })
}

export async function listarComprasAsync(limite = 200): Promise<Compra[]> {
  const safeLimit = Math.min(1000, Math.max(1, limite))
  const statement = await getAsyncDb().prepare(
    `SELECT p.id, p.variant_id, p.quantity, p.total, p.shipping, p.bought_at, p.supplier, p.notes,
            v.name AS variante, s.id AS insumo_id, s.name AS insumo, s.unit
       FROM purchases p JOIN supply_variants v ON v.id = p.variant_id
       JOIN supplies s ON s.id = v.supply_id
      ORDER BY p.bought_at DESC, p.id DESC LIMIT ?`
  )
  const rows = (await statement.all([safeLimit])) as {
    id: number; variant_id: number; variante: string; insumo_id: number; insumo: string;
    unit: string; quantity: number; total: number; shipping: number; bought_at: number;
    supplier: string | null; notes: string | null
  }[]
  return rows.map((row) => ({
    id: row.id, varianteId: row.variant_id, varianteNome: row.variante,
    insumoId: row.insumo_id, insumoNome: row.insumo, unidade: row.unit,
    quantidade: row.quantity, valor: row.total, frete: row.shipping,
    custoUnitario: row.quantity > 0 ? arredonda((row.total + row.shipping) / row.quantity, 4) : 0,
    compradoEm: row.bought_at, fornecedor: row.supplier, observacao: row.notes
  }))
}

export async function criarInsumoAsync(input: {
  nome: string; unidade: string; estoqueMinimo?: number | null;
  observacao?: string | null; variantes?: string[]
}): Promise<number> {
  const db = getAsyncDb()
  const insert = await db.prepare(
    'INSERT INTO supplies (name, unit, min_stock, notes, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const result = await insert.run([
    input.nome, input.unidade, input.estoqueMinimo ?? null, input.observacao ?? null, Date.now()
  ])
  const id = Number(result.lastInsertRowid)
  const variant = await db.prepare('INSERT INTO supply_variants (supply_id, name) VALUES (?, ?)')
  for (const name of input.variantes?.length ? input.variantes : ['Padrão']) {
    await variant.run([id, name])
  }
  return id
}

export async function atualizarInsumoAsync(
  id: number,
  input: { nome?: string; unidade?: string; estoqueMinimo?: number | null; observacao?: string | null }
): Promise<void> {
  const db = getAsyncDb()
  const fields: [string, unknown][] = [
    ['name', input.nome], ['unit', input.unidade], ['min_stock', input.estoqueMinimo],
    ['notes', input.observacao]
  ]
  for (const [column, value] of fields) {
    if (value === undefined) continue
    const statement = await db.prepare(`UPDATE supplies SET ${column} = ? WHERE id = ?`)
    await statement.run([value, id])
  }
}

export async function removerInsumoAsync(id: number): Promise<void> {
  const statement = await getAsyncDb().prepare('DELETE FROM supplies WHERE id = ?')
  await statement.run([id])
}

export async function criarVarianteAsync(insumoId: number, nome: string): Promise<number> {
  const statement = await getAsyncDb().prepare(
    'INSERT INTO supply_variants (supply_id, name) VALUES (?, ?)'
  )
  return Number((await statement.run([insumoId, nome])).lastInsertRowid)
}

export async function renomearVarianteAsync(id: number, nome: string): Promise<void> {
  const statement = await getAsyncDb().prepare('UPDATE supply_variants SET name = ? WHERE id = ?')
  await statement.run([nome, id])
}

export async function removerVarianteAsync(id: number): Promise<void> {
  const statement = await getAsyncDb().prepare('DELETE FROM supply_variants WHERE id = ?')
  await statement.run([id])
}

export async function registrarCompraAsync(input: {
  varianteId: number; quantidade: number; valor: number; frete?: number;
  compradoEm?: number; fornecedor?: string | null; observacao?: string | null
}): Promise<number> {
  const db = getAsyncDb()
  const when = input.compradoEm ?? Date.now()
  const purchase = await db.prepare(
    `INSERT INTO purchases (variant_id, quantity, total, shipping, bought_at, supplier, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const result = await purchase.run([
    input.varianteId, input.quantidade, input.valor, input.frete ?? 0, when,
    input.fornecedor ?? null, input.observacao ?? null, Date.now()
  ])
  const id = Number(result.lastInsertRowid)
  const move = await db.prepare(
    `INSERT INTO stock_moves (variant_id, quantity, reason, ref, purchase_id, happened_at)
     VALUES (?, ?, 'compra', ?, ?, ?)`
  )
  await move.run([input.varianteId, input.quantidade, `compra:${id}`, id, when])
  return id
}

export async function removerCompraAsync(id: number): Promise<void> {
  const db = getAsyncDb()
  const moves = await db.prepare('DELETE FROM stock_moves WHERE purchase_id = ?')
  const purchase = await db.prepare('DELETE FROM purchases WHERE id = ?')
  await moves.run([id])
  await purchase.run([id])
}

export async function ajustarEstoqueAsync(
  varianteId: number,
  quantidade: number,
  observacao?: string
): Promise<void> {
  const statement = await getAsyncDb().prepare(
    `INSERT INTO stock_moves (variant_id, quantity, reason, happened_at, notes)
     VALUES (?, ?, 'ajuste', ?, ?)`
  )
  await statement.run([varianteId, quantidade, Date.now(), observacao ?? null])
}

export async function listarMovimentosAsync(limite = 100): Promise<MovimentoEstoque[]> {
  const statement = await getAsyncDb().prepare(
    `SELECT m.id, m.variant_id, m.quantity, m.reason, m.order_sn, m.happened_at, m.notes,
            v.name AS variante, s.name AS insumo, s.unit
       FROM stock_moves m JOIN supply_variants v ON v.id = m.variant_id
       JOIN supplies s ON s.id = v.supply_id
      ORDER BY m.happened_at DESC, m.id DESC LIMIT ?`
  )
  const rows = (await statement.all([Math.min(1000, Math.max(1, limite))])) as {
    id: number; variant_id: number; variante: string; insumo: string; unit: string;
    quantity: number; reason: string; order_sn: string | null; happened_at: number; notes: string | null
  }[]
  return rows.map((row) => ({
    id: row.id, varianteId: row.variant_id, insumoNome: row.insumo,
    varianteNome: row.variante, unidade: row.unit, quantidade: row.quantity,
    motivo: row.reason as MovimentoEstoque['motivo'], orderSn: row.order_sn,
    aconteceuEm: row.happened_at, observacao: row.notes
  }))
}
