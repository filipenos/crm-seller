import { useEffect, useState } from 'react'
import type { Order, OrderTab, TabCounts, WorkflowStage } from '@shared/types'
import {
  LOGISTICS_READY_TO_POST,
  MAIN_TABS,
  ORDER_TAB_LABELS,
  isWithUs
} from '@shared/types'
import OrderDetail from '../components/OrderDetail'

interface Props {
  dataVersion: number
}

export default function OrdersPage({ dataVersion }: Props): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [tabFilter, setTabFilter] = useState<OrderTab | 'TODOS'>('TODOS')
  const [readyToPost, setReadyToPost] = useState(false)
  const [stages, setStages] = useState<WorkflowStage[]>([])
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
    void window.api.stages.list().then(setStages)
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

  const handleStageChange = async (orderSn: string, stageId: number): Promise<void> => {
    await window.api.orders.setStage(orderSn, stageId)
    refresh()
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
              <th>Comprador</th>
              <th>Itens</th>
              <th>Nome (person.)</th>
              <th>Situação</th>
              <th>Etapa (produção)</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderSn} onClick={() => setSelected(o.orderSn)}>
                <td className="mono">{o.orderSn}</td>
                <td>{o.buyerName ?? o.buyerUsername ?? '-'}</td>
                <td>
                  {o.items.length === 0
                    ? '-'
                    : o.items.map((i) => `${i.quantity}x ${i.itemName}`).join(', ')}
                </td>
                <td>{o.childName ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`phase-badge ph-${o.tab}`}>{o.shopeeStatus ?? ORDER_TAB_LABELS[o.tab]}</span>
                  {o.logisticsCode === LOGISTICS_READY_TO_POST && (
                    <div className="ready-tag">🏷️ etiqueta gerada</div>
                  )}
                  {o.logisticsStatus && (
                    <div className="logistics-status" title={o.logisticsStatus}>
                      🚚 {o.logisticsStatus}
                    </div>
                  )}
                  <div className="order-flags">
                    {o.ratingStar != null && (
                      <span title={`Avaliado: ${o.ratingStar}/5`}>⭐{o.ratingStar}</span>
                    )}
                    {o.escrowReleasedAt && (
                      <span title="Pagamento liberado pela Shopee">💰</span>
                    )}
                  </div>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {/* Etapa de produção só faz sentido enquanto o pedido está
                      conosco; depois de postado quem descreve é a Shopee. */}
                  {isWithUs(o.tab) ? (
                    <select
                      className="status-select"
                      style={o.stageColor ? { borderLeft: `4px solid ${o.stageColor}` } : undefined}
                      value={o.stageId ?? ''}
                      onChange={(e) => handleStageChange(o.orderSn, Number(e.target.value))}
                    >
                      {o.stageId === null && <option value="">— sem etapa —</option>}
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="row-actions">
                    <button title="Abrir pasta do pedido" onClick={() => handleOpenFolder(o.orderSn)}>
                      📁
                    </button>
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
