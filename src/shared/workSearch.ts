import type { AgendaTrabalho } from './types'

export interface WorkSearchResult {
  orderSn: string
  buyerUsername: string | null
  childName: string | null
  itens: string[]
  origem: 'agenda' | 'entrega'
  data: string | null
  postarAte: number | null
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
}

export function searchWorkOrders(agenda: AgendaTrabalho, query: string, hideDone: boolean): WorkSearchResult[] {
  const terms = normalize(query.trim()).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const orders = new Map<string, WorkSearchResult & { buyerName: string | null }>()
  for (const day of agenda.dias) {
    for (const order of day.pedidos) {
      if (hideDone && order.feito) continue
      orders.set(order.orderSn, { orderSn: order.orderSn, buyerUsername: order.buyerUsername,
        buyerName: order.buyerName, childName: order.childName, itens: order.itens, origem: 'agenda', data: day.data,
        postarAte: Date.parse(`${day.postarAte}T00:00:00-03:00`) })
    }
  }
  for (const order of agenda.paraEntregar) {
    if (hideDone) continue
    orders.set(order.orderSn, { orderSn: order.orderSn, buyerUsername: order.buyerUsername,
      buyerName: order.buyerName, childName: order.childName, itens: order.itens, origem: 'entrega', data: null,
      postarAte: order.postarAte })
  }
  return [...orders.values()].filter((order) => {
    const haystack = normalize([order.orderSn, order.buyerUsername, order.buyerName, order.childName, ...order.itens].filter(Boolean).join(' '))
    return terms.every((term) => haystack.includes(term))
  }).sort((a, b) => (a.postarAte ?? Infinity) - (b.postarAte ?? Infinity) || a.orderSn.localeCompare(b.orderSn))
}
