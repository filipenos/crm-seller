import { useEffect, useState } from 'react'
import type { Order, OrderCounts, OrderTab } from '@shared/types'
import { calcularPercentualTaxas, MAIN_TABS, ORDER_TAB_LABELS } from '@shared/types'
import OrderDetail from '../components/OrderDetail'

const PAGE_SIZE = 50

/** Menos de 24h para postar: o prazo da Shopee vira multa se estourar. */
function prazoApertado(shipByDate: number): boolean {
  return shipByDate - Date.now() < 24 * 60 * 60 * 1000
}

interface Props {
  dataVersion: number
}

export default function OrdersPage({ dataVersion }: Props): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  // Entra direto no que precisa de trabalho hoje, não na base inteira.
  const [tabFilter, setTabFilter] = useState<OrderTab | 'TODOS'>('A_ENVIAR')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [counts, setCounts] = useState<OrderCounts | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [limit, setLimit] = useState(PAGE_SIZE)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let current = true
    setOrders([])
    setLoading(true)
    void window.api.orders
      .list({ tab: tabFilter, search: debouncedSearch, limit })
      .then((nextOrders) => {
        if (current) setOrders(nextOrders)
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [tabFilter, debouncedSearch, limit, dataVersion])

  useEffect(() => {
    void window.api.orders.tabCounts().then(setCounts)
  }, [dataVersion])

  const refresh = (): void => {
    setLoading(true)
    void window.api.orders
      .list({ tab: tabFilter, search: debouncedSearch, limit })
      .then(setOrders)
      .finally(() => setLoading(false))
    void window.api.orders.tabCounts().then(setCounts)
  }

  const changeTab = (tab: OrderTab | 'TODOS'): void => {
    if (tab === tabFilter) return
    setSelected(null)
    setOrders([])
    setLoading(true)
    setLimit(PAGE_SIZE)
    setTabFilter(tab)
  }

  const showToast = (msg: string): void => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  const handleOpenFolder = async (orderSn: string): Promise<void> => {
    const result = await window.api.orders.openFolder(orderSn)
    if (!result.ok) showToast(`Erro: ${result.error}`)
    else refresh()
  }

  // Os totais vêm do banco e ficam sempre visíveis: são eles que dizem quanto
  // trabalho existe em cada aba antes de clicar.
  // "Todos" não conta cancelados, que são a última aba.
  const total = counts ? MAIN_TABS.reduce((soma, t) => soma + counts.tabs[t], 0) : orders.length

  return (
    <div className="page orders-page">
      <header className="page-header">
        <h1>Pedidos</h1>
        <input
          className="search"
          placeholder="Buscar em tudo, ou use tema: produto: nick: nome: id: url: rastreio:"
          title="Sem prefixo procura em todos os campos. Com prefixo restringe a um: tema:kpop, nick:comprador, rastreio:BR123, url:2390000000000"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setLimit(PAGE_SIZE)
            setOrders([])
            setLoading(true)
          }}
        />
      </header>

      <div className="status-tabs">
        <button
          className={tabFilter === 'TODOS' ? 'active' : ''}
          onClick={() => changeTab('TODOS')}
        >
          Todos ({total})
        </button>
        {MAIN_TABS.map((t) => (
          <button
            key={t}
            className={tabFilter === t ? 'active' : ''}
            onClick={() => changeTab(t)}
          >
            {ORDER_TAB_LABELS[t]} ({counts?.tabs[t] ?? 0})
          </button>
        ))}
        <button
          className={tabFilter === 'CANCELADO' ? 'active' : ''}
          onClick={() => changeTab('CANCELADO')}
        >
          {ORDER_TAB_LABELS.CANCELADO} ({counts?.tabs.CANCELADO ?? 0})
        </button>
      </div>

      {loading ? (
        <div className="empty loading-indicator">Carregando pedidos…</div>
      ) : orders.length === 0 ? (
        <div className="empty">
          Nenhum pedido ainda. Conecte a Shopee em <b>Configurações</b> e clique em{' '}
          <b>Sincronizar</b>.
        </div>
      ) : (
        <>
        <table className="orders-table">
          <thead>
            <tr>
              <th>Pedido</th>
              <th>Produto</th>
              <th>Qtd</th>
              <th>Valor pago</th>
              <th>Recebido</th>
              <th>Postar até</th>
              <th>Situação</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderSn} onClick={() => setSelected(o.orderSn)}>
                <td>
                  <div className="mono">{o.orderSn}</div>
                  {/* O nome do destinatário vem mascarado pela Shopee ("E******a"),
                      então não informa nada — o username identifica melhor. */}
                  <small className="muted">
                    {o.createdAtShopee
                      ? new Date(o.createdAtShopee).toLocaleDateString('pt-BR')
                      : '—'}
                    {o.buyerUsername ? ` · ${o.buyerUsername}` : ''}
                  </small>
                </td>
                <td className="col-produto">
                  {o.items.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    o.items.map((i) => (
                      <div key={i.id}>
                        <div className="produto-nome" title={i.itemName}>
                          {i.itemName}
                        </div>
                        {/* "description" é a variação: "15 peças / 3 de cada modelo" */}
                        {i.modelName && <small className="muted">{i.modelName}</small>}
                      </div>
                    ))
                  )}
                </td>
                <td className="num">{o.items.reduce((soma, i) => soma + i.quantity, 0) || '—'}</td>
                <td className="num">
                  <div>{o.totalAmount != null ? `R$ ${o.totalAmount.toFixed(2)}` : '—'}</div>
                  {o.paymentMethod && (
                    <div>
                      <small className="muted">{o.paymentMethod}</small>
                    </div>
                  )}
                </td>
                <td className="num">
                  {o.recebimento?.valorRecebido != null ? (
                    <>
                      {/* Valor sem data de liberação é previsão, não dinheiro
                          na conta — por isso fica esmaecido e datado. */}
                      <div className={o.recebimento.recebidoEm ? '' : 'muted'}>
                        R$ {o.recebimento.valorRecebido.toFixed(2)}
                      </div>
                      {calcularPercentualTaxas(o.recebimento) != null ? (
                        <div>
                          <small
                            className="muted"
                            title="Comissão + serviço + outras taxas sobre o valor após o cupom"
                          >
                            taxas {calcularPercentualTaxas(o.recebimento)}%
                          </small>
                        </div>
                      ) : null}
                      {!o.recebimento.recebidoEm && o.recebimento.previstoPara ? (
                        <div>
                          <span className="previsto" title="Valor calculado; ainda não caiu na conta">
                            previsto {new Date(o.recebimento.previstoPara).toLocaleDateString('pt-BR')}
                          </span>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <small className="muted">aguardando</small>
                  )}
                </td>
                <td>
                  {o.shipByDate ? (
                    <span
                      className={
                        o.tab === 'A_ENVIAR' && prazoApertado(o.shipByDate) ? 'prazo-curto' : ''
                      }
                    >
                      {new Date(o.shipByDate).toLocaleDateString('pt-BR')}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <span className={`phase-badge ph-${o.tab}`}>
                    {o.shopeeStatus ?? ORDER_TAB_LABELS[o.tab]}
                  </span>
                  {o.readyToPost && (
                    <div className="ready-tag">🏷️ etiqueta gerada</div>
                  )}
                  {o.statusDescription && (
                    <small className="muted" title={o.statusDescription}>
                      {o.statusDescription}
                    </small>
                  )}
                  <div className="order-flags">
                    {o.shippingCity && <span className="muted">📍 {o.shippingCity}</span>}
                    {o.ratingStar != null && (
                      <span title={`Avaliado: ${o.ratingStar}/5`}>⭐{o.ratingStar}</span>
                    )}
                    {o.escrowReleasedAt && <span title="Pagamento liberado">💰</span>}
                  </div>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="row-actions">
                    {o.shopeeUrlPath && (
                      <button
                        title="Abrir este pedido no Seller Center"
                        onClick={() =>
                          window.api.shell.openExternal(
                            `https://seller.shopee.com.br${o.shopeeUrlPath}`
                          )
                        }
                      >
                        ↗
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === limit && (
          <div className="load-more">
            <button onClick={() => setLimit((current) => current + PAGE_SIZE)}>
              Carregar mais pedidos
            </button>
          </div>
        )}
        </>
      )}

      {selected && (
        <OrderDetail
          key={selected}
          orderSn={selected}
          initialOrder={orders.find((order) => order.orderSn === selected)}
          onClose={() => setSelected(null)}
          onOrderChange={(changedOrder) =>
            setOrders((currentOrders) =>
              currentOrders.map((order) =>
                order.orderSn === changedOrder.orderSn ? changedOrder : order
              )
            )
          }
          onToast={showToast}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
