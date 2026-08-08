import { useEffect, useState } from 'react'
import type {
  Order,
  OrderEvent,
  StageAction,
  StatusHistoryEntry,
  WorkflowStage
} from '@shared/types'
import { ORDER_PHASE_LABELS, isWithUs } from '@shared/types'

const EVENT_ICONS: Record<OrderEvent['source'], string> = {
  logistics: '🚚',
  rating: '⭐',
  finance: '💰',
  status: '📋'
}

interface Props {
  orderSn: string
  onClose: () => void
  onToast: (msg: string) => void
}

export default function OrderDetail({ orderSn, onClose, onToast }: Props): React.JSX.Element {
  const [order, setOrder] = useState<Order | null>(null)
  const [history, setHistory] = useState<StatusHistoryEntry[]>([])
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [childName, setChildName] = useState('')
  const [note, setNote] = useState('')
  const [stages, setStages] = useState<WorkflowStage[]>([])

  const load = async (): Promise<void> => {
    const o = await window.api.orders.get(orderSn)
    setOrder(o)
    setChildName(o?.childName ?? '')
    setNote(o?.note ?? '')
    setHistory(await window.api.orders.statusHistory(orderSn))
    setEvents(await window.api.events.byOrder(orderSn))
    setStages(await window.api.stages.list())
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderSn])

  if (!order) return <div className="drawer-backdrop" onClick={onClose} />

  const saveChildName = async (): Promise<void> => {
    await window.api.orders.setChildName(orderSn, childName)
    onToast('Nome salvo')
    void load()
  }

  const saveNote = async (): Promise<void> => {
    await window.api.orders.setNote(orderSn, note)
    onToast('Observação salva')
  }

  const setStage = async (stageId: number): Promise<void> => {
    await window.api.orders.setStage(orderSn, stageId)
    void load()
  }

  /** Executa a ação cadastrada na etapa. */
  const runAction = async (action: StageAction): Promise<void> => {
    switch (action.kind) {
      case 'CRIAR_PASTA': {
        const r = await window.api.orders.createFolder(orderSn)
        onToast(r.ok ? `Pasta criada: ${r.path}` : `Erro: ${r.error}`)
        break
      }
      case 'ABRIR_PASTA': {
        const r = await window.api.orders.openFolder(orderSn)
        if (!r.ok) onToast(`Erro: ${r.error}`)
        break
      }
      case 'AVANCAR': {
        const next = await window.api.stages.next(order?.stageId ?? null)
        if (next === null) onToast('Já está na última etapa')
        else await setStage(next)
        break
      }
    }
    void load()
  }

  const currentStage = stages.find((s) => s.id === order.stageId)

  const useAsName = (text: string): void => {
    setChildName(text.trim())
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <header className="drawer-header">
          <div>
            <h2 className="mono">{order.orderSn}</h2>
            <div className="muted">
              {order.buyerName ?? order.buyerUsername ?? '-'}
              {order.buyerUsername ? ` (@${order.buyerUsername})` : ''}
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <section>
          <h3>Fase</h3>
          <div className={`phase-badge big ph-${order.phase}`}>
            {ORDER_PHASE_LABELS[order.phase]}
          </div>
          {order.logisticsStatus && (
            <div className="muted">🚚 {order.logisticsStatus}</div>
          )}
        </section>

        {isWithUs(order.phase) ? (
          <section>
            <h3>Etapa de produção</h3>
            <div className="status-buttons">
              {stages.map((s) => (
                <button
                  key={s.id}
                  className={`badge-btn ${order.stageId === s.id ? 'current' : ''}`}
                  style={s.color ? { borderLeft: `4px solid ${s.color}` } : undefined}
                  onClick={() => setStage(s.id)}
                >
                  {s.name}
                </button>
              ))}
            </div>
            {currentStage && currentStage.actions.length > 0 && (
              <div className="action-buttons">
                {currentStage.actions.map((a) => (
                  <button key={a.id} onClick={() => runAction(a)}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section>
            <p className="muted">
              O pedido já saiu daqui — a produção terminou quando ele foi postado. Agora só o
              rastreio e o pagamento mudam de estado.
            </p>
          </section>
        )}

        <section>
          <h3>Personalização</h3>
          <div className="field-row">
            <input
              placeholder="Nome da criança"
              value={childName}
              onChange={(e) => setChildName(e.target.value)}
            />
            <button onClick={saveChildName}>Salvar</button>
          </div>
          <div className="field-row">
            <textarea
              placeholder="Observações do pedido…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
            />
            <button onClick={saveNote}>Salvar</button>
          </div>
        </section>

        <section>
          <h3>Itens</h3>
          <ul className="item-list">
            {order.items.length === 0 && <li className="muted">Sem itens sincronizados</li>}
            {order.items.map((i) => (
              <li key={i.id}>
                <b>{i.quantity}x</b> {i.itemName}
                {i.modelName && <span className="muted"> — {i.modelName}</span>}
              </li>
            ))}
          </ul>
          <div className="muted small">
            Shopee: {order.shopeeStatus ?? '-'}
            {order.trackingNumber ? ` · Rastreio: ${order.trackingNumber}` : ''}
            {order.totalAmount != null
              ? ` · Total: ${order.currency ?? 'R$'} ${order.totalAmount.toFixed(2)}`
              : ''}
          </div>
          <div className="shopee-flags">
            {order.deliveredAt && (
              <span className="flag ok">
                ✅ Entregue em {new Date(order.deliveredAt).toLocaleDateString('pt-BR')}
              </span>
            )}
            {order.ratingStar != null && (
              <span className="flag" title={order.ratingComment ?? ''}>
                ⭐ Avaliado: {order.ratingStar}/5
              </span>
            )}
            {order.escrowReleasedAt && (
              <span className="flag ok">
                💰 Pagamento recebido
                {order.escrowAmount != null ? ` (R$ ${order.escrowAmount.toFixed(2)})` : ''} em{' '}
                {new Date(order.escrowReleasedAt).toLocaleDateString('pt-BR')}
              </span>
            )}
          </div>
        </section>

        <section>
          <div className="section-title-row">
            <h3>Linha do tempo Shopee</h3>
            <button
              className="small-btn"
              onClick={async () => {
                onToast('Atualizando rastreio…')
                const r = await window.api.orders.refreshTracking(orderSn)
                if (!r.ok) onToast(`Erro no rastreio: ${r.error}`)
                else
                  onToast(
                    r.newEvents > 0
                      ? `${r.newEvents} novo(s) evento(s): ${r.latestStatus}`
                      : 'Rastreio sem novidades'
                  )
                void load()
              }}
            >
              🔄 Atualizar rastreio
            </button>
          </div>
          {events.length === 0 ? (
            <div className="muted">
              Nenhum evento ainda — rastreio, avaliação e pagamento aparecem aqui após a
              sincronização.
            </div>
          ) : (
            <ul className="timeline">
              {[...events].reverse().map((e) => (
                <li key={e.eventKey}>
                  <span className="timeline-icon">{EVENT_ICONS[e.source]}</span>
                  <div>
                    <div>{e.description}</div>
                    <div className="muted small">
                      {new Date(e.happenedAt).toLocaleString('pt-BR')}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3>Ações</h3>
          <div className="action-buttons">
            <button
              onClick={async () => {
                const r = await window.api.orders.createFolder(orderSn)
                onToast(r.ok ? `Pasta criada: ${r.path}` : `Erro: ${r.error}`)
                void load()
              }}
            >
              📁 Criar pasta (template)
            </button>
            <button
              onClick={async () => {
                const r = await window.api.orders.openFolder(orderSn)
                if (!r.ok) onToast(`Erro: ${r.error}`)
              }}
            >
              📂 Abrir pasta
            </button>
          </div>
          {order.folderPath && (
            <div className="muted small mono">Pasta: {order.folderPath}</div>
          )}
        </section>


        <section>
          <h3>Histórico de status</h3>
          <ul className="history">
            {history.map((h) => (
              <li key={h.id}>
                <span className="muted">{new Date(h.changedAt).toLocaleString('pt-BR')}</span>{' '}
                {h.fromStatus ? `${h.fromStatus} → ` : ''}
                <b>{h.toStatus}</b>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  )
}
