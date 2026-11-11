import { getAsyncDb } from '../db'
import { dashboardDates } from '@shared/dashboardDays'
import { inferProductKind, parseBowVariation } from '@shared/productVariation'
import type { AgendaDia, AgendaPedido, AgendaQuantidade, AgendaTrabalho, InternalStatus, ProductKind } from '@shared/types'

interface OrderItemRow {
  order_sn: string
  buyer_username: string | null
  buyer_name: string | null
  child_name: string | null
  created_at_shopee: number | null
  ship_by_date: number
  internal_status: InternalStatus
  tab: string
  label_generated_at: number | null
  ready_to_post: number
  item_name: string | null
  model_name: string | null
  quantity: number | null
  pecas: number | null
  lacos: number | null
  kind: ProductKind | null
  production_stage: string | null
}

interface BoxRow {
  name: string
  quantity: number | null
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
  const [rawItems, rawBoxes, rawCounts, rawToDeliver] = await getAsyncDb().queryBatch([
    { sql: `SELECT o.order_sn, o.buyer_username, o.buyer_name, o.child_name, o.created_at_shopee, o.ship_by_date, o.internal_status,
        o.tab, o.label_generated_at, o.ready_to_post,
        i.item_name, i.model_name, i.quantity, i.pecas, i.lacos, p.kind,
        ps.code AS production_stage
      FROM orders o LEFT JOIN order_items i ON i.order_sn = o.order_sn
      LEFT JOIN products p ON p.item_id = i.item_id
      LEFT JOIN order_item_work w ON w.order_sn = i.order_sn
        AND w.item_id = COALESCE(i.item_id, '') AND w.model_id = COALESCE(i.model_id, '')
      LEFT JOIN production_stages ps ON ps.id = w.stage_id
      WHERE o.tab IN ('A_ENVIAR', 'ENVIADO', 'CONCLUIDO')
        AND o.ship_by_date >= ? AND o.ship_by_date < ?
      ORDER BY o.ship_by_date, o.created_at_shopee IS NULL, o.created_at_shopee, o.order_sn, i.id`, parameters: [lower, upper] },
    { sql: `SELECT box.name, part.quantity
      FROM composition_items kit
      JOIN composition_parts part ON part.parent_item_id = kit.id
      JOIN composition_items box ON box.id = part.child_item_id AND box.kind = 'CAIXA'
      WHERE kit.slug = 'kit-caixas' ORDER BY part.position, box.id` },
    { sql: `SELECT
        SUM(CASE WHEN ship_by_date < ? THEN 1 ELSE 0 END) AS atrasados,
        SUM(CASE WHEN ship_by_date IS NULL THEN 1 ELSE 0 END) AS sem_prazo
      FROM orders WHERE tab = 'A_ENVIAR' AND label_generated_at IS NULL AND ready_to_post = 0`, parameters: [lower] },
    { sql: `SELECT o.order_sn, o.buyer_username, o.buyer_name, o.child_name, o.label_generated_at, o.ship_by_date,
        i.item_name, i.model_name, i.quantity
      FROM orders o LEFT JOIN order_items i ON i.order_sn = o.order_sn
      WHERE o.tab = 'A_ENVIAR' AND (o.label_generated_at IS NOT NULL OR o.ready_to_post = 1)
        AND NOT EXISTS (SELECT 1 FROM order_events e
          WHERE e.order_sn = o.order_sn AND e.source = 'logistics'
            AND (LOWER(e.description) LIKE '%postado%' OR LOWER(e.description) LIKE '%coletado%'))
      ORDER BY o.ship_by_date IS NULL, o.ship_by_date, o.created_at_shopee, o.order_sn, i.id` }
  ])
  const boxRows = rawBoxes as BoxRow[]
  const baseBoxes = boxRows.reduce((total, box) => total + (box.quantity ?? 0), 0)
  const byDay = new Map<string, {
    orders: Map<string, AgendaPedido>
    bowOrders: Set<string>
    boxOrders: Set<string>
    doneOrders: Set<string>
    doneBowOrders: Set<string>
    doneBoxOrders: Set<string>
    bows: Map<string, number>
    boxes: Map<string, number>
    doneBows: number
    doneBoxes: number
  }>()
  for (let offset = 0; offset < days; offset++) {
    byDay.set(addDays(hoje, offset), {
      orders: new Map(), bowOrders: new Set(), boxOrders: new Set(), doneOrders: new Set(), doneBowOrders: new Set(), doneBoxOrders: new Set(), bows: new Map(), boxes: new Map(), doneBows: 0, doneBoxes: 0
    })
  }

  for (const row of rawItems as OrderItemRow[]) {
    const shipDay = new Date(row.ship_by_date - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const day = byDay.get(addDays(shipDay, -1))
    if (!day) continue
    const embalado = row.production_stage === 'PACKED'
    const feito = embalado || row.label_generated_at !== null || row.ready_to_post === 1 || row.tab !== 'A_ENVIAR'
    let order = day.orders.get(row.order_sn)
    if (!order) {
      order = { orderSn: row.order_sn, buyerUsername: row.buyer_username, buyerName: row.buyer_name, childName: row.child_name, createdAtShopee: row.created_at_shopee, status: row.internal_status, itens: [], pendencias: [], embalado, feito, producao: [] }
      day.orders.set(row.order_sn, order)
    } else {
      order.feito = order.feito && feito
      order.embalado = order.embalado && embalado
    }
    if (!row.item_name) {
      if (!order.pendencias.includes('Pedido sem itens')) order.pendencias.push('Pedido sem itens')
      continue
    }
    order.itens.push(`${row.quantity ?? 1}× ${row.item_name}${row.model_name ? ` · ${row.model_name}` : ''}`)
    const amount = row.quantity ?? 0
    if (!Number.isFinite(amount) || amount <= 0) {
      order.pendencias.push(`Quantidade não informada: ${row.item_name}`)
      continue
    }
    const inferred = inferProductKind(row.item_name)
    const kind = row.kind ?? (inferred === 'LACOS' ? 'LACOS'
      : row.pecas || piecesFromVariation(row.model_name) ? 'CAIXAS' : 'OUTRO')
    const bowColor = kind === 'LACOS' ? parseBowVariation(row.model_name)?.color ?? null : null
    order.producao.push({ tipo: kind, cor: bowColor, feito })
    if (kind === 'LACOS') {
      day.bowOrders.add(row.order_sn)
      if (feito) day.doneBowOrders.add(row.order_sn)
      const perKit = row.lacos ?? parseBowVariation(row.model_name)?.size ?? null
      const color = bowColor
      if (perKit === null || perKit <= 0 || !color) {
        order.pendencias.push(`Cor ou quantidade de laços não identificada: ${row.item_name}`)
        continue
      }
      if (feito) day.doneBows += amount * perKit
      else add(day.bows, color, amount * perKit)
    } else if (kind === 'CAIXAS') {
      day.boxOrders.add(row.order_sn)
      if (feito) day.doneBoxOrders.add(row.order_sn)
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
        if (feito) day.doneBoxes += count
        else add(day.boxes, box.name, count)
      }
    } else {
      order.pendencias.push(`Produto sem composição de produção: ${row.item_name}`)
    }
  }

  for (const day of byDay.values()) {
    for (const order of day.orders.values()) if (order.feito) day.doneOrders.add(order.orderSn)
  }

  const dias: AgendaDia[] = [...byDay].map(([data, item]) => ({
    data,
    postarAte: addDays(data, 1),
    pedidos: [...item.orders.values()],
    pedidosLacos: item.bowOrders.size,
    pedidosCaixas: item.boxOrders.size,
    pedidosFeitos: item.doneOrders.size,
    pedidosLacosFeitos: item.doneBowOrders.size,
    pedidosCaixasFeitos: item.doneBoxOrders.size,
    lacosFeitos: item.doneBows,
    caixasFeitas: item.doneBoxes,
    lacos: quantities(item.bows),
    caixas: quantities(item.boxes)
  }))
  const counts = rawCounts[0] as { atrasados: number | null; sem_prazo: number | null } | undefined
  const deliveryOrders = new Map<string, AgendaTrabalho['paraEntregar'][number]>()
  for (const row of rawToDeliver as { order_sn: string; buyer_username: string | null; buyer_name: string | null; child_name: string | null; label_generated_at: number | null; ship_by_date: number | null; item_name: string | null; model_name: string | null; quantity: number | null }[]) {
    let order = deliveryOrders.get(row.order_sn)
    if (!order) {
      order = { orderSn: row.order_sn, buyerUsername: row.buyer_username, buyerName: row.buyer_name, childName: row.child_name, etiquetaEm: row.label_generated_at, postarAte: row.ship_by_date, itens: [] }
      deliveryOrders.set(row.order_sn, order)
    }
    if (row.item_name) order.itens.push(`${row.quantity ?? 1}× ${row.item_name}${row.model_name ? ` · ${row.model_name}` : ''}`)
  }
  const paraEntregar = [...deliveryOrders.values()]
  return { hoje, dias, paraEntregar, atrasados: Number(counts?.atrasados ?? 0), semPrazo: Number(counts?.sem_prazo ?? 0) }
}
