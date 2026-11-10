import type { MetricaPainel, Order, OrderCounts, OrderTab, Painel, PainelOffsets, SerieMensal } from '../../shared/types'

export interface WebProductionData {
  items: Array<{ id: number; name: string; kind: string; unit: string; sellable: number; stock_controlled: number; reference_cost: number | null; waste_percent: number; stock: number; average_cost: number | null; parts: number }>
  purchases: Array<{ id: number; bought_at: number; item_name: string; variant_name: string | null; quantity: number; total: number; shipping: number; supplier: string | null; unit: string }>
  lots: Array<{ id: number; produced_at: number; item_name: string; variant_name: string | null; quantity: number; estimated_unit_cost: number; actual_total_cost: number; notes: string | null }>
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin' })
  const body = await response.json() as T | { error?: string }
  if (!response.ok) throw new Error('error' in (body as object) ? (body as { error?: string }).error : 'Não foi possível carregar os dados.')
  return body as T
}

export const api = {
  painel: {
    resumo: (offsets: PainelOffsets): Promise<Painel> =>
      get(`/api/dashboard?vendas=${offsets.vendas}&previstas=${offsets.previstas}&etiquetas=${offsets.etiquetas}`),
    serie: (metric: MetricaPainel, year: number, month: number): Promise<SerieMensal> =>
      get(`/api/dashboard/series?metric=${encodeURIComponent(metric)}&year=${year}&month=${month}`)
  },
  web: {
    orders: (tab: OrderTab | 'TODOS', search: string, limit: number): Promise<{ orders: Order[]; counts: OrderCounts }> =>
      get(`/api/orders?tab=${encodeURIComponent(tab)}&search=${encodeURIComponent(search)}&limit=${limit}`),
    production: (): Promise<WebProductionData> => get('/api/production')
  }
}
