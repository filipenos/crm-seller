import { useEffect, useState } from 'react'
import { api, type WebProductionData } from './api'

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const NUM = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })

export default function WebProductionPage(): React.JSX.Element {
  const [data, setData] = useState<WebProductionData | null>(null)
  useEffect(() => { void api.web.production().then(setData) }, [])
  if (!data) return <div className="page"><div className="empty loading-indicator">Carregando fabricação…</div></div>
  return <div className="page"><header className="page-header"><div><h1>Fabricação</h1><span className="muted">Consulta online de composição, custos e estoque</span></div></header>
    <h2 className="section-title">Itens e estoque</h2><table className="tabela"><thead><tr><th>Item</th><th>Tipo</th><th>Unidade</th><th className="num">Estoque</th><th className="num">Custo</th><th className="num">Componentes</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><b>{item.name}</b></td><td>{item.kind}</td><td>{item.unit}</td><td className="num">{item.stock_controlled ? NUM.format(item.stock) : '—'}</td><td className="num">{item.average_cost !== null ? BRL.format(item.average_cost) : item.reference_cost !== null ? `${BRL.format(item.reference_cost)} estimado` : '—'}</td><td className="num">{item.parts}</td></tr>)}</tbody></table>
    <h2 className="section-title">Compras recentes</h2><table className="tabela"><thead><tr><th>Data</th><th>Item</th><th>Versão</th><th className="num">Quantidade</th><th className="num">Total</th><th>Fornecedor</th></tr></thead><tbody>{data.purchases.map((purchase) => <tr key={purchase.id}><td>{new Date(purchase.bought_at).toLocaleDateString('pt-BR')}</td><td>{purchase.item_name}</td><td>{purchase.variant_name ?? 'Padrão'}</td><td className="num">{NUM.format(purchase.quantity)} {purchase.unit}</td><td className="num">{BRL.format(purchase.total + purchase.shipping)}</td><td>{purchase.supplier ?? '—'}</td></tr>)}</tbody></table>
    <h2 className="section-title">Lotes de produção</h2><table className="tabela"><thead><tr><th>Data</th><th>Item</th><th>Versão</th><th className="num">Quantidade</th><th className="num">Custo estimado</th><th className="num">Custo real</th></tr></thead><tbody>{data.lots.map((lot) => <tr key={lot.id}><td>{new Date(lot.produced_at).toLocaleDateString('pt-BR')}</td><td>{lot.item_name}</td><td>{lot.variant_name ?? 'Padrão'}</td><td className="num">{NUM.format(lot.quantity)}</td><td className="num">{BRL.format(lot.estimated_unit_cost * lot.quantity)}</td><td className="num">{BRL.format(lot.actual_total_cost)}</td></tr>)}</tbody></table>
  </div>
}
