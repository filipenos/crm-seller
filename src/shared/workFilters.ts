import type { AgendaDia, AgendaPedido } from './types'

export type DayFilter = { tipo?: 'LACOS' | 'CAIXAS'; cor?: string; situacao?: 'todos' | 'feitos' | 'fazer' }

export function workFilterSituation(filter: DayFilter, hideDone: boolean): 'todos' | 'feitos' | 'fazer' {
  return filter.situacao ?? (hideDone ? 'fazer' : 'todos')
}

export function filterWorkDayOrders(orders: AgendaPedido[], filter: DayFilter, hideDone: boolean): AgendaPedido[] {
  const situacao = workFilterSituation(filter, hideDone)
  return orders.filter((order) => {
    if (situacao === 'feitos' && !order.feito) return false
    if (situacao === 'fazer' && order.feito) return false
    return !filter.tipo || order.producao.some((item) => item.tipo === filter.tipo &&
      (!filter.cor || item.cor === filter.cor) && (situacao !== 'fazer' || !item.feito))
  })
}

export function visibleWorkColors(day: AgendaDia, filter: DayFilter, hideDone: boolean): string[] {
  const situacao = workFilterSituation(filter, hideDone)
  if (situacao === 'fazer') return day.lacos.map((item) => item.nome)
  return [...new Set(day.pedidos
    .filter((order) => situacao !== 'feitos' || order.feito)
    .flatMap((order) => order.producao
      .filter((item) => item.tipo === 'LACOS' && item.cor)
      .map((item) => item.cor as string)))]
}

export function workColorQuantity(day: AgendaDia, color: string, filter: DayFilter, hideDone: boolean): number | null {
  const pending = day.lacos.find((item) => item.nome === color)?.quantidade
  const done = day.lacosFeitosPorCor.find((item) => item.nome === color)?.quantidade
  const situacao = workFilterSituation(filter, hideDone)
  if (situacao === 'fazer') return pending ?? null
  if (situacao === 'feitos') return done ?? null
  return pending === undefined && done === undefined ? null : (pending ?? 0) + (done ?? 0)
}
