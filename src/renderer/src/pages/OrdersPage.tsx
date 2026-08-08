import { useEffect, useState } from 'react'
import type { Order, OrderPhase, WorkflowStage } from '@shared/types'
import { ORDER_PHASES, ORDER_PHASE_LABELS, isWithUs } from '@shared/types'
import OrderDetail from '../components/OrderDetail'

interface Props {
  dataVersion: number
}

export default function OrdersPage({ dataVersion }: Props): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [phaseFilter, setPhaseFilter] = useState<OrderPhase | 'TODOS'>('TODOS')
  const [stages, setStages] = useState<WorkflowStage[]>([])
  const [search, setSearch] = useState('')
  const [awaitingPayment, setAwaitingPayment] = useState(false)
  const [awaitingCount, setAwaitingCount] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    void window.api.orders.list({ phase: phaseFilter, search, awaitingPayment }).then(setOrders)
    void window.api.orders.awaitingPaymentCount().then(setAwaitingCount)
    void window.api.stages.list().then(setStages)
  }, [phaseFilter, search, awaitingPayment, dataVersion])

  const refresh = (): void => {
    void window.api.orders.list({ phase: phaseFilter, search, awaitingPayment }).then(setOrders)
    void window.api.orders.awaitingPaymentCount().then(setAwaitingCount)
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

  const handleLabel = async (orderSn: string): Promise<void> => {
    showToast('Gerando etiqueta…')
    const result = await window.api.orders.generateLabel(orderSn)
    if (!result.ok) showToast(`Erro na etiqueta: ${result.error}`)
    else {
      showToast(`Etiqueta salva em ${result.path}`)
      refresh()
    }
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

  const counts = new Map<string, number>()
  for (const o of orders) counts.set(o.phase, (counts.get(o.phase) ?? 0) + 1)

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
          className={phaseFilter === 'TODOS' ? 'active' : ''}
          onClick={() => setPhaseFilter('TODOS')}
        >
          Todos
        </button>
        {ORDER_PHASES.map((p) => (
          <button
            key={p}
            className={phaseFilter === p ? 'active' : ''}
            onClick={() => setPhaseFilter(p)}
          >
            {ORDER_PHASE_LABELS[p]}
            {phaseFilter === 'TODOS' && counts.get(p) ? ` (${counts.get(p)})` : ''}
          </button>
        ))}
        <button
          className={`awaiting-payment ${awaitingPayment ? 'active' : ''}`}
          title="Pedidos entregues cujo pagamento ainda não foi liberado pela Shopee"
          onClick={() => setAwaitingPayment(!awaitingPayment)}
        >
          💰 Aguardando pagamento{awaitingCount > 0 ? ` (${awaitingCount})` : ''}
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
              <th>Fase</th>
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
                  <span className={`phase-badge ph-${o.phase}`}>{ORDER_PHASE_LABELS[o.phase]}</span>
                  {o.logisticsStatus && (
                    <div className="logistics-status" title={o.logisticsStatus}>
                      🚚 {o.logisticsStatus}
                    </div>
                  )}
                  <div className="order-flags">
                    {o.ratingStar != null && (
                      <span title={`Avaliado: ${o.ratingStar}/5`}>⭐{o.ratingStar}</span>
                    )}
                    <span className="muted" title="Status na Shopee">
                      {o.shopeeStatus ?? ''}
                    </span>
                  </div>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {/* Etapa de produção só faz sentido enquanto o pedido está
                      conosco; depois de postado quem descreve é a fase. */}
                  {isWithUs(o.phase) ? (
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
                    <button title="Gerar etiqueta" onClick={() => handleLabel(o.orderSn)}>
                      🏷️
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
