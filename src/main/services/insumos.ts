import { getAsyncDb, getDb } from '../db'
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

export function listarInsumos(): Insumo[] {
  const db = getDb()
  const insumos = db
    .prepare('SELECT * FROM supplies ORDER BY name COLLATE NOCASE')
    .all() as { id: number; name: string; unit: string; min_stock: number | null; notes: string | null }[]

  const variantes = db
    .prepare(
      `SELECT v.id, v.supply_id, v.name,
              ${ESTOQUE_SQL} AS estoque,
              ${CUSTO_MEDIO_SQL} AS custo_medio,
              (SELECT COUNT(*) FROM purchases p WHERE p.variant_id = v.id) AS compras
         FROM supply_variants v
        ORDER BY v.name COLLATE NOCASE`
    )
    .all() as VarianteRow[]

  const porInsumo = new Map<number, VarianteInsumo[]>()
  for (const v of variantes) {
    const lista = porInsumo.get(v.supply_id) ?? []
    lista.push({
      id: v.id,
      nome: v.name,
      estoque: arredonda(v.estoque),
      custoMedio: v.custo_medio === null ? null : arredonda(v.custo_medio, 4),
      compras: v.compras
    })
    porInsumo.set(v.supply_id, lista)
  }

  return insumos.map((s) => {
    const vs = porInsumo.get(s.id) ?? []
    const estoque = arredonda(vs.reduce((soma, v) => soma + v.estoque, 0))
    // Só avisa o que já foi comprado alguma vez. Sem isso, um cadastro recém
    // criado grita que tudo está acabando — quando na verdade nada começou.
    const acompanhado = vs.some((v) => v.compras > 0)
    return {
      id: s.id,
      nome: s.name,
      unidade: s.unit as Unidade,
      estoqueMinimo: s.min_stock,
      observacao: s.notes,
      variantes: vs,
      estoque,
      custoMedio: custoMedioDoInsumo(s.id),
      acabando: acompanhado && s.min_stock !== null && estoque <= s.min_stock
    }
  })
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

/**
 * Custo médio do insumo, somando as compras de todas as cores.
 *
 * Não é a média dos custos das variantes: comprar 1000 folhas baratas e 10
 * caras não faz o papel custar o meio-termo. O que vale é o total pago dividido
 * pelo total comprado.
 */
export function custoMedioDoInsumo(insumoId: number): number | null {
  const row = getDb()
    .prepare(
      `SELECT SUM(p.total + p.shipping) AS pago, SUM(p.quantity) AS qtd
         FROM purchases p
         JOIN supply_variants v ON v.id = p.variant_id
        WHERE v.supply_id = ?`
    )
    .get(insumoId) as { pago: number | null; qtd: number | null }
  if (!row.pago || !row.qtd) return null
  return arredonda(row.pago / row.qtd, 4)
}

export function criarInsumo(input: {
  nome: string
  unidade: string
  estoqueMinimo?: number | null
  observacao?: string | null
  variantes?: string[]
}): number {
  const db = getDb()
  const criar = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO supplies (name, unit, min_stock, notes, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(input.nome, input.unidade, input.estoqueMinimo ?? null, input.observacao ?? null, Date.now())
    const id = Number(info.lastInsertRowid)
    // Todo insumo precisa de ao menos uma variante, porque é nela que o estoque
    // mora — quem não tem cor fica com uma só, chamada "Padrão".
    const nomes = input.variantes?.length ? input.variantes : ['Padrão']
    for (const nome of nomes) {
      db.prepare('INSERT INTO supply_variants (supply_id, name) VALUES (?, ?)').run(id, nome)
    }
    return id
  })
  return criar()
}

export function atualizarInsumo(
  id: number,
  input: { nome?: string; unidade?: string; estoqueMinimo?: number | null; observacao?: string | null }
): void {
  const db = getDb()
  if (input.nome !== undefined) db.prepare('UPDATE supplies SET name = ? WHERE id = ?').run(input.nome, id)
  if (input.unidade !== undefined) db.prepare('UPDATE supplies SET unit = ? WHERE id = ?').run(input.unidade, id)
  if (input.estoqueMinimo !== undefined)
    db.prepare('UPDATE supplies SET min_stock = ? WHERE id = ?').run(input.estoqueMinimo, id)
  if (input.observacao !== undefined)
    db.prepare('UPDATE supplies SET notes = ? WHERE id = ?').run(input.observacao, id)
}

export function removerInsumo(id: number): void {
  getDb().prepare('DELETE FROM supplies WHERE id = ?').run(id)
}

export function criarVariante(insumoId: number, nome: string): number {
  const info = getDb()
    .prepare('INSERT INTO supply_variants (supply_id, name) VALUES (?, ?)')
    .run(insumoId, nome)
  return Number(info.lastInsertRowid)
}

export function renomearVariante(id: number, nome: string): void {
  getDb().prepare('UPDATE supply_variants SET name = ? WHERE id = ?').run(nome, id)
}

export function removerVariante(id: number): void {
  getDb().prepare('DELETE FROM supply_variants WHERE id = ?').run(id)
}

/** Compra registrada é entrada de estoque: as duas coisas nascem juntas. */
export function registrarCompra(input: {
  varianteId: number
  quantidade: number
  valor: number
  frete?: number
  compradoEm?: number
  fornecedor?: string | null
  observacao?: string | null
}): number {
  const db = getDb()
  const quando = input.compradoEm ?? Date.now()
  const salvar = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO purchases (variant_id, quantity, total, shipping, bought_at, supplier, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.varianteId,
        input.quantidade,
        input.valor,
        input.frete ?? 0,
        quando,
        input.fornecedor ?? null,
        input.observacao ?? null,
        Date.now()
      )
    const id = Number(info.lastInsertRowid)
    db.prepare(
      `INSERT INTO stock_moves (variant_id, quantity, reason, ref, purchase_id, happened_at)
       VALUES (?, ?, 'compra', ?, ?, ?)`
    ).run(input.varianteId, input.quantidade, `compra:${id}`, id, quando)
    return id
  })
  return salvar()
}

export function removerCompra(id: number): void {
  const db = getDb()
  const apagar = db.transaction(() => {
    db.prepare('DELETE FROM stock_moves WHERE purchase_id = ?').run(id)
    db.prepare('DELETE FROM purchases WHERE id = ?').run(id)
  })
  apagar()
}

export function listarCompras(limite = 200): Compra[] {
  const rows = getDb()
    .prepare(
      `SELECT p.*, v.name AS variante, s.id AS insumo_id, s.name AS insumo, s.unit
         FROM purchases p
         JOIN supply_variants v ON v.id = p.variant_id
         JOIN supplies s ON s.id = v.supply_id
        ORDER BY p.bought_at DESC, p.id DESC
        LIMIT ?`
    )
    .all(limite) as {
    id: number
    variant_id: number
    variante: string
    insumo_id: number
    insumo: string
    unit: string
    quantity: number
    total: number
    shipping: number
    bought_at: number
    supplier: string | null
    notes: string | null
  }[]

  return rows.map((r) => ({
    id: r.id,
    varianteId: r.variant_id,
    varianteNome: r.variante,
    insumoId: r.insumo_id,
    insumoNome: r.insumo,
    unidade: r.unit,
    quantidade: r.quantity,
    valor: r.total,
    frete: r.shipping,
    custoUnitario: r.quantity > 0 ? arredonda((r.total + r.shipping) / r.quantity, 4) : 0,
    compradoEm: r.bought_at,
    fornecedor: r.supplier,
    observacao: r.notes
  }))
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

/** Correção manual de estoque: contou a gaveta, perdeu, estragou. */
export function ajustarEstoque(varianteId: number, quantidade: number, observacao?: string): void {
  getDb()
    .prepare(
      `INSERT INTO stock_moves (variant_id, quantity, reason, happened_at, notes)
       VALUES (?, ?, 'ajuste', ?, ?)`
    )
    .run(varianteId, quantidade, Date.now(), observacao ?? null)
}

export function listarMovimentos(limite = 100): MovimentoEstoque[] {
  const rows = getDb()
    .prepare(
      `SELECT m.*, v.name AS variante, s.name AS insumo, s.unit
         FROM stock_moves m
         JOIN supply_variants v ON v.id = m.variant_id
         JOIN supplies s ON s.id = v.supply_id
        ORDER BY m.happened_at DESC, m.id DESC
        LIMIT ?`
    )
    .all(limite) as {
    id: number
    variant_id: number
    variante: string
    insumo: string
    unit: string
    quantity: number
    reason: string
    order_sn: string | null
    happened_at: number
    notes: string | null
  }[]

  return rows.map((r) => ({
    id: r.id,
    varianteId: r.variant_id,
    insumoNome: r.insumo,
    varianteNome: r.variante,
    unidade: r.unit,
    quantidade: r.quantity,
    motivo: r.reason as MovimentoEstoque['motivo'],
    orderSn: r.order_sn,
    aconteceuEm: r.happened_at,
    observacao: r.notes
  }))
}

/**
 * De qual cor tirar, quando a receita não diz.
 *
 * A receita pede "fita nº9"; a cor depende do tema, que o app ainda não sabe.
 * Tirar da variante com mais estoque é o palpite que erra menos e nunca deixa
 * saldo negativo sem motivo — e o ajuste manual corrige quando errar.
 */
export function varianteParaConsumo(insumoId: number): number | null {
  const row = getDb()
    .prepare(
      `SELECT v.id, ${ESTOQUE_SQL} AS estoque
         FROM supply_variants v
        WHERE v.supply_id = ?
        ORDER BY estoque DESC, v.id ASC
        LIMIT 1`
    )
    .get(insumoId) as { id: number } | undefined
  return row?.id ?? null
}

export function estoqueDoInsumo(insumoId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(m.quantity), 0) AS estoque
         FROM stock_moves m
         JOIN supply_variants v ON v.id = m.variant_id
        WHERE v.supply_id = ?`
    )
    .get(insumoId) as { estoque: number }
  return arredonda(row.estoque)
}
