import { useEffect, useState } from 'react'
import { calcularPercentualTaxas, MAIN_TABS, ORDER_TAB_LABELS, type Order, type OrderCounts, type OrderTab } from '../../shared/types'
import { api } from './api'

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export default function WebOrdersPage({ initialBuyerUsername }: { initialBuyerUsername?: string | null }): React.JSX.Element {
  const [tab, setTab] = useState<OrderTab | 'TODOS'>(initialBuyerUsername ? 'TODOS' : 'A_ENVIAR')
  const [buyerUsername, setBuyerUsername] = useState(initialBuyerUsername ?? null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [orders, setOrders] = useState<Order[]>([])
  const [counts, setCounts] = useState<OrderCounts | null>(null)
  const [selected, setSelected] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [limit, setLimit] = useState(50)

  useEffect(() => { const timer = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timer) }, [search])
  useEffect(() => {
    let active = true; setLoading(true); setOrders([])
    void api.web.orders(tab, query, limit, buyerUsername).then((result) => { if (active) { setOrders(result.orders); setCounts(result.counts) } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [tab, query, limit, buyerUsername])
  const total = counts ? MAIN_TABS.reduce((sum, current) => sum + counts.tabs[current], 0) : 0

  return <div className="page orders-page">
    <header className="page-header"><h1>Pedidos</h1><input className="search" placeholder="Buscar pedido, cliente, nome ou produto…" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(50) }} /></header>
    {buyerUsername && <div className="orders-buyer-filter">Pedidos de <b>{buyerUsername}</b><button type="button" onClick={() => { setBuyerUsername(null); setTab('A_ENVIAR'); setLimit(50) }}>Limpar filtro</button></div>}
    <div className="status-tabs"><button className={tab === 'TODOS' ? 'active' : ''} onClick={() => setTab('TODOS')}>Todos{buyerUsername ? '' : ` (${total})`}</button>{MAIN_TABS.map((value) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{ORDER_TAB_LABELS[value]}{buyerUsername ? '' : ` (${counts?.tabs[value] ?? 0})`}</button>)}<button className={tab === 'CANCELADO' ? 'active' : ''} onClick={() => setTab('CANCELADO')}>Cancelados{buyerUsername ? '' : ` (${counts?.tabs.CANCELADO ?? 0})`}</button></div>
    {loading ? <div className="empty loading-indicator">Carregando pedidos…</div> : <table className="orders-table"><thead><tr><th>Pedido</th><th>Produto</th><th>Qtd.</th><th>Valor pago</th><th>Recebido</th><th>Postar até</th><th>Situação</th></tr></thead><tbody>{orders.map((order) => <tr key={order.orderSn} onClick={() => setSelected(order)}><td><div className="mono">{order.orderSn}</div><small className="muted">{order.createdAtShopee ? new Date(order.createdAtShopee).toLocaleDateString('pt-BR') : '—'}{order.buyerUsername ? ` · ${order.buyerUsername}` : ''}</small></td><td className="col-produto">{order.items.map((item) => <div key={item.id}><div className="produto-nome">{item.itemName}</div>{item.modelName && <small className="muted">{item.modelName}</small>}</div>)}</td><td className="num">{order.items.reduce((sum, item) => sum + item.quantity, 0)}</td><td className="num">{order.totalAmount === null ? '—' : BRL.format(order.totalAmount)}</td><td className="num">{order.recebimento?.valorRecebido == null ? <span className="muted">aguardando</span> : <>{BRL.format(order.recebimento.valorRecebido)}{calcularPercentualTaxas(order.recebimento) !== null && <small className="muted block">taxas {calcularPercentualTaxas(order.recebimento)}%</small>}</>}</td><td>{order.shipByDate ? new Date(order.shipByDate).toLocaleDateString('pt-BR') : '—'}</td><td><span className={`phase-badge ph-${order.tab}`}>{order.shopeeStatus ?? ORDER_TAB_LABELS[order.tab]}</span>{order.stageName && <small className="muted block">{order.stageName}</small>}</td></tr>)}</tbody></table>}
    {!loading && orders.length === limit && <div className="load-more"><button onClick={() => setLimit((current) => current + 50)}>Carregar mais pedidos</button></div>}
    {selected && <><div className="drawer-backdrop" onClick={() => setSelected(null)} /><div className="drawer"><header className="drawer-header"><div><h2 className="mono">{selected.orderSn}</h2><div className="muted">{selected.buyerUsername ?? '—'}</div></div><button className="close-btn" onClick={() => setSelected(null)}>✕</button></header><section><h3>Situação</h3><span className={`phase-badge big ph-${selected.tab}`}>{selected.shopeeStatus ?? ORDER_TAB_LABELS[selected.tab]}</span>{selected.stageName && <p>Etapa de produção: <b>{selected.stageName}</b></p>}</section><section><h3>Personalização</h3><p>Nome: <b>{selected.childName || '—'}</b></p><p>{selected.note || 'Sem observações.'}</p></section><section><h3>Itens</h3><ul className="item-list">{selected.items.map((item) => <li key={item.id}><b>{item.quantity}x</b> {item.itemName}{item.modelName && <span className="muted"> — {item.modelName}</span>}</li>)}</ul></section>{selected.recebimento && <section><h3>Recebimento</h3><p>Produtos: {selected.recebimento.valorProdutos === null ? '—' : BRL.format(selected.recebimento.valorProdutos)}</p><p>Taxas: {selected.recebimento.totalTaxas === null ? '—' : BRL.format(selected.recebimento.totalTaxas)}</p><p><b>Recebido: {selected.recebimento.valorRecebido === null ? '—' : BRL.format(selected.recebimento.valorRecebido)}</b></p></section>}</div></>}
  </div>
}
