import { getAsyncDb } from '../db'
import { dashboardDates } from '@shared/dashboardDays'
import { inferProductKind, parseBowVariation } from '@shared/productVariation'
import type { AgendaDia, AgendaPedido, AgendaQuantidade, AgendaTrabalho, InternalStatus, ProductKind } from '@shared/types'

interface OrderItemRow {
  order_sn: string
  ship_by_date: number
  internal_status: InternalStatus
  item_name: string | null
  model_name: string | null
  quantity: number | null
  pecas: number | null
  lacos: number | null
  kind: ProductKind | null
}

interface BoxRow {
  name: string
  quantity: number | null
  bows: number | null
}

function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10)
}

function midnight(day: string): number {
  return Date.parse(`${day}T00:00:00-03:00`)
}

function quantities(values: Map<string, number>): AgendaQuantidade[] {
  return [...values].map(([nome, quantidade]) => ({ nome, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade || a.nome.localeCompare(b.nome, 'pt-BR'))
}

function add(values: Map<string, number>, name: string, amount: number): void {
  values.set(name, (values.get(name) ?? 0) + amount)
}

function piecesFromVariation(name: string | null): number | null {
  const match = name && /(\d+)\s*(?:pe[çc]as?|unidades?|un\b)/i.exec(name)
  return match ? Number(match[1]) : null
}

/** Uma leitura em lote; trocar o seletor de dias não dispara consultas por pedido. */
export async function workAgenda(days: number): Promise<AgendaTrabalho> {
  if (!Number.isInteger(days) || days < 1 || days > 10) throw new Error('Escolha de 1 a 10 dias.')
  const { today: hoje } = dashboardDates()
  const lower = midnight(addDays(hoje, 1))
  const upper = midnight(addDays(hoje, days + 1))
  const [rawItems, rawBoxes, rawCounts] = await getAsyncDb().queryBatch([
    { sql: `SELECT o.order_sn, o.ship_by_date, o.internal_status,
        i.item_name, i.model_name, i.quantity, i.pecas, i.lacos, p.kind
      FROM orders o LEFT JOIN order_items i ON i.order_sn = o.order_sn
      LEFT JOIN products p ON p.item_id = i.item_id
      WHERE o.tab = 'A_ENVIAR' AND o.ship_by_date >= ? AND o.ship_by_date < ?
      ORDER BY o.ship_by_date, o.order_sn, i.id`, parameters: [lower, upper] },
    { sql: `SELECT box.name, part.quantity,
        (SELECT SUM(bow_part.quantity) FROM composition_parts bow_part
          JOIN composition_items bow ON bow.id = bow_part.child_item_id
          WHERE bow_part.parent_item_id = box.id AND bow.slug = 'laco') AS bows
      FROM composition_items kit
      JOIN composition_parts part ON part.parent_item_id = kit.id
      JOIN composition_items box ON box.id = part.child_item_id AND box.kind = 'CAIXA'
      WHERE kit.slug = 'kit-caixas' ORDER BY part.position, box.id` },
    { sql: `SELECT
        SUM(CASE WHEN ship_by_date < ? THEN 1 ELSE 0 END) AS atrasados,
        SUM(CASE WHEN ship_by_date IS NULL THEN 1 ELSE 0 END) AS sem_prazo
      FROM orders WHERE tab = 'A_ENVIAR'`, parameters: [lower] }
  ])
  const boxRows = rawBoxes as BoxRow[]
  const baseBoxes = boxRows.reduce((total, box) => total + (box.quantity ?? 0), 0)
  const byDay = new Map<string, {
    orders: Map<string, AgendaPedido>
    bows: Map<string, number>
    boxes: Map<string, number>
  }>()
  for (let offset = 0; offset < days; offset++) {
    byDay.set(addDays(hoje, offset), { orders: new Map(), bows: new Map(), boxes: new Map() })
  }

  for (const row of rawItems as OrderItemRow[]) {
    const shipDay = new Date(row.ship_by_date - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const day = byDay.get(addDays(shipDay, -1))
    if (!day) continue
    const embalado = ['EMBALADO', 'ENVIADO', 'CONCLUIDO'].includes(row.internal_status)
    let order = day.orders.get(row.order_sn)
    if (!order) {
      order = { orderSn: row.order_sn, status: row.internal_status, itens: [], pendencias: [], embalado }
      day.orders.set(row.order_sn, order)
    }
    if (!row.item_name) {
      if (!order.pendencias.includes('Pedido sem itens')) order.pendencias.push('Pedido sem itens')
      continue
    }
    order.itens.push(`${row.quantity ?? 1}× ${row.item_name}${row.model_name ? ` · ${row.model_name}` : ''}`)
    if (embalado) continue
    const amount = row.quantity ?? 0
    if (!Number.isFinite(amount) || amount <= 0) {
      order.pendencias.push(`Quantidade não informada: ${row.item_name}`)
      continue
    }
    const inferred = inferProductKind(row.item_name)
    const kind = row.kind ?? (inferred === 'LACOS' ? 'LACOS'
      : row.pecas || piecesFromVariation(row.model_name) ? 'CAIXAS' : 'OUTRO')
    if (kind === 'LACOS') {
      const perKit = row.lacos ?? parseBowVariation(row.model_name)?.size ?? null
      if (perKit === null || perKit <= 0) {
        order.pendencias.push(`Quantidade de laços não identificada: ${row.item_name}`)
        continue
      }
      const color = parseBowVariation(row.model_name)?.color ?? 'Cor a definir'
      add(day.bows, color, amount * perKit)
    } else if (kind === 'CAIXAS') {
      const total = row.pecas ?? piecesFromVariation(row.model_name)
      if (!total || baseBoxes <= 0 || boxRows.some((box) => box.quantity === null)) {
        order.pendencias.push(`Composição ou quantidade de caixas pendente: ${row.item_name}`)
        continue
      }
      const multiplier = amount * total / baseBoxes
      if (boxRows.some((box) => !Number.isInteger(multiplier * (box.quantity ?? 0)))) {
        order.pendencias.push(`Quantidade incompatível com a composição: ${row.item_name}`)
        continue
      }
      for (const box of boxRows) {
        const count = multiplier * (box.quantity ?? 0)
        add(day.boxes, box.name, count)
        if (box.bows) add(day.bows, 'Cor a definir', count * box.bows)
      }
    } else {
      order.pendencias.push(`Produto sem composição de produção: ${row.item_name}`)
    }
  }

  const dias: AgendaDia[] = [...byDay].map(([data, item]) => ({
    data,
    postarAte: addDays(data, 1),
    pedidos: [...item.orders.values()],
    lacos: quantities(item.bows),
    caixas: quantities(item.boxes)
  }))
  const counts = rawCounts[0] as { atrasados: number | null; sem_prazo: number | null } | undefined
  return { hoje, dias, atrasados: Number(counts?.atrasados ?? 0), semPrazo: Number(counts?.sem_prazo ?? 0) }
}
