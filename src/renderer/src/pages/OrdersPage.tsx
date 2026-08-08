import { useEffect, useState } from 'react'
import type { Order, OrderTab, TabCounts } from '@shared/types'
import { LOGISTICS_READY_TO_POST, MAIN_TABS, ORDER_TAB_LABELS } from '@shared/types'
import OrderDetail from '../components/OrderDetail'

/** Menos de 24h para postar: o prazo da Shopee vira multa se estourar. */
function prazoApertado(shipByDate: number): boolean {
  return shipByDate - Date.now() < 24 * 60 * 60 * 1000
}

interface Props {
  dataVersion: number
}

export default function OrdersPage({ dataVersion }: Props): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [tabFilter, setTabFilter] = useState<OrderTab | 'TODOS'>('TODOS')
  const [readyToPost, setReadyToPost] = useState(false)
  const [search, setSearch] = useState('')
  const [awaitingPayment, setAwaitingPayment] = useState(false)
  const [awaitingCount, setAwaitingCount] = useState(0)
  const [counts, setCounts] = useState<TabCounts | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    void window.api.orders.list({ tab: tabFilter, search, awaitingPayment, readyToPost: readyToPost || undefined }).then(setOrders)
    void window.api.orders.awaitingPaymentCount().then(setAwaitingCount)
    void window.api.orders.tabCounts().then(setCounts)
  }, [tabFilter, search, awaitingPayment, readyToPost, dataVersion])

  const refresh = (): void => {
    void window.api.orders.list({ tab: tabFilter, search, awaitingPayment, readyToPost: readyToPost || undefined }).then(setOrders)
    void window.api.orders.awaitingPaymentCount().then(setAwaitingCount)
    void window.api.orders.tabCounts().then(setCounts)
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

  const handleRefreshTracking = async (orderSn: string): Promise<void> => {
    showToast('Atualizando rastreio…')
    const r = await window.api.orders.refreshTracking(orderSn)
    if (!r.ok) showToast(`Erro no rastreio: ${r.error}`)
    else {
      showToast(r.newEvents > 0 ? `Rastreio: ${r.latestStatus}` : 'Rastreio sem novidades')
      refresh()
    }
  }

  // Os totais só aparecem sem filtro: com uma aba escolhida, o número dela
  // seria o da própria lista e os outros, ruído.
  const semFiltro = tabFilter === 'TODOS' && !awaitingPayment && !readyToPost
  // "Todos" não conta cancelados — eles têm página própria, como na Shopee.
  const total = counts ? MAIN_TABS.reduce((soma, t) => soma + counts[t], 0) : orders.length
  const prontosParaPostar = orders.filter((o) => o.logisticsCode === LOGISTICS_READY_TO_POST).length

  const limpaFiltros = (): void => {
    setAwaitingPayment(false)
    setReadyToPost(false)
  }

  return (
    <div className="page orders-page">
      <header className="page-header">
        <h1>Pedidos</h1>
        <input
          className="search"
          placeholder="Buscar por pedido, comprador ou nome…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>

      <div className="status-tabs">
        <button
          className={semFiltro && tabFilter === 'TODOS' ? 'active' : ''}
          onClick={() => {
            setTabFilter('TODOS')
            limpaFiltros()
          }}
        >
          Todos{semFiltro ? ` (${total})` : ''}
        </button>
        {MAIN_TABS.map((t) => (
          <button
            key={t}
            className={tabFilter === t && !readyToPost ? 'active' : ''}
            onClick={() => {
              setTabFilter(t)
              limpaFiltros()
            }}
          >
            {ORDER_TAB_LABELS[t]}
            {semFiltro ? ` (${counts?.[t] ?? 0})` : ''}
          </button>
        ))}
        {/* Corte de produção: dentro de "A enviar", os que já têm etiqueta
            gerada são os que podem ir para o ponto de coleta hoje. */}
        <button
          className={`ready-to-post ${readyToPost ? 'active' : ''}`}
          title="Pedidos a enviar com etiqueta já gerada — prontos para levar ao ponto de coleta"
          onClick={() => {
            setReadyToPost(!readyToPost)
            setTabFilter('A_ENVIAR')
            setAwaitingPayment(false)
          }}
        >
          🏷️ Prontos para postar
          {tabFilter === 'A_ENVIAR' && !readyToPost ? ` (${prontosParaPostar})` : ''}
        </button>
        <button
          className={tabFilter === 'CANCELADO' ? 'active' : ''}
          onClick={() => {
            setTabFilter('CANCELADO')
            limpaFiltros()
          }}
        >
          {ORDER_TAB_LABELS.CANCELADO}
          {semFiltro ? ` (${counts?.CANCELADO ?? 0})` : ''}
        </button>
        <button
          className={`awaiting-payment ${awaitingPayment ? 'active' : ''}`}
          title="Pedidos entregues cujo pagamento ainda não foi liberado pela Shopee"
          onClick={() => {
            setAwaitingPayment(!awaitingPayment)
            setTabFilter('TODOS')
            setReadyToPost(false)
          }}
        >
          💰 Aguardando pagamento{semFiltro && awaitingCount > 0 ? ` (${awaitingCount})` : ''}
        </button>
      </div>

      {orders.length === 0 ? (
        <div className="empty">
          Nenhum pedido ainda. Conecte a Shopee em <b>Configurações</b> e clique em{' '}
          <b>Sincronizar</b>.
        </div>
      ) : (
        <table className="orders-table">
          <thead>
            <tr>
              <th>Pedido</th>
              <th>Produto</th>
              <th>Qtd</th>
              <th>Valor pago</th>
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
                  <small className="muted">
                    {o.createdAtShopee
                      ? new Date(o.createdAtShopee).toLocaleDateString('pt-BR')
                      : '—'}
                    {o.buyerName || o.buyerUsername ? ` · ${o.buyerName ?? o.buyerUsername}` : ''}
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
                  {o.totalAmount != null ? `R$ ${o.totalAmount.toFixed(2)}` : '—'}
                  {o.paymentMethod && <small className="muted"> {o.paymentMethod}</small>}
                </td>
                <td>
                  {o.shipByDate ? (
                    <span className={prazoApertado(o.shipByDate) ? 'prazo-curto' : ''}>
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
                  {o.logisticsCode === LOGISTICS_READY_TO_POST && (
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
                    <button
                      title="Atualizar rastreio deste pedido"
                      onClick={() => handleRefreshTracking(o.orderSn)}
                    >
                      🔄
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <OrderDetail
          orderSn={selected}
          onClose={() => {
            setSelected(null)
            refresh()
          }}
          onToast={showToast}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
