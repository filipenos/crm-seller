import { useEffect, useState } from 'react'
import type {
  Order,
  OrderEvent,
  StatusHistoryEntry,
  ProductionItem,
  ProductionActionKind
} from '@shared/types'
import {
  calcularPercentualTaxas,
  calcularValorAposCupom,
  ORDER_TAB_LABELS
} from '@shared/types'

/** Linha do extrato; omitida quando a Shopee não mandou o valor. */
function Linha({
  rotulo,
  valor,
  sempreVisivel = false
}: {
  rotulo: string
  valor: number | null
  sempreVisivel?: boolean
}): React.JSX.Element | null {
  if (!sempreVisivel && (valor === null || valor === 0)) return null
  return (
    <tr>
      <td>{rotulo}</td>
      <td className={`num ${valor !== null && valor < 0 ? 'negativo' : ''}`}>
        {valor !== null ? `R$ ${valor.toFixed(2)}` : '—'}
      </td>
    </tr>
  )
}

const EVENT_ICONS: Record<OrderEvent['source'], string> = {
  logistics: '🚚',
  rating: '⭐',
  finance: '💰',
  status: '📋'
}

interface Props {
  orderSn: string
  initialOrder?: Order
  onClose: () => void
  onOrderChange: (order: Order) => void
  onToast: (msg: string) => void
  onEditArt: (orderSn: string) => void
}

export default function OrderDetail({
  orderSn,
  initialOrder,
  onClose,
  onOrderChange,
  onToast,
  onEditArt
}: Props): React.JSX.Element {
  const [order, setOrder] = useState<Order | null>(initialOrder ?? null)
  const [history, setHistory] = useState<StatusHistoryEntry[]>([])
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [childName, setChildName] = useState(initialOrder?.childName ?? '')
  const [note, setNote] = useState(initialOrder?.note ?? '')
  const [production, setProduction] = useState<ProductionItem[]>([])
  const [productionBusy, setProductionBusy] = useState<string | null>(null)
  const [productionError, setProductionError] = useState<string | null>(null)
  const [refreshingIncome, setRefreshingIncome] = useState(false)
  const [refreshingTracking, setRefreshingTracking] = useState(false)
  const load = async (): Promise<void> => {
    // Todas começam juntas, mas o pedido libera o formulário assim que chega;
    // histórico, eventos e etapas não seguram mais a abertura do painel.
    const extras = Promise.all([
      window.api.orders.statusHistory(orderSn),
      window.api.events.byOrder(orderSn),
      window.api.production.order(orderSn)
    ])
    const o = await window.api.orders.get(orderSn)
    setOrder(o)
    if (o) onOrderChange(o)
    setChildName(o?.childName ?? '')
    setNote(o?.note ?? '')
    const [novoHistorico, novosEventos, novosItens] = await extras
    setHistory(novoHistorico)
    setEvents(novosEventos)
    setProduction(novosItens)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderSn])

  if (!order) {
    return (
      <>
        <div className="drawer-backdrop" onClick={onClose} />
        <div className="drawer drawer-loading" aria-busy="true">
          <header className="drawer-header">
            <h2 className="mono">{orderSn}</h2>
            <button className="close-btn" onClick={onClose}>✕</button>
          </header>
          <div className="loading-indicator">Carregando pedido…</div>
        </div>
      </>
    )
  }

  const saveChildName = async (): Promise<void> => {
    await window.api.orders.setChildName(orderSn, childName)
    onToast('Nome salvo')
    void load()
  }

  const saveNote = async (): Promise<void> => {
    await window.api.orders.setNote(orderSn, note)
    const updatedOrder = { ...order, note }
    setOrder(updatedOrder)
    onOrderChange(updatedOrder)
    onToast('Observação salva')
  }

  const runProductionAction = async (item: ProductionItem, kind: ProductionActionKind): Promise<void> => {
    const key = `${item.itemId}:${item.modelId}`
    setProductionBusy(key)
    setProductionError(null)
    try {
      if (kind === 'GENERATE_ART' || kind === 'EDIT_ART') {
        onEditArt(orderSn)
        return
      }
      if (kind === 'PRINT_ART' || kind === 'RETRY_PRINT') {
        if (!item.templateKey) throw new Error('Vincule um tema a este produto antes de imprimir.')
        await window.api.art.orderOpenLatest(orderSn, item.templateKey)
        if (kind === 'RETRY_PRINT') return
      }
      setProduction(await window.api.production.act(orderSn, item.itemId, item.modelId, kind))
    } catch (error) {
      setProductionError(error instanceof Error ? error.message : String(error))
    } finally {
      setProductionBusy(null)
    }
  }

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
            <div className="muted">{order.buyerUsername ?? '-'}</div>
          </div>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <section>
          <h3>Situação</h3>
          <div className={`phase-badge big ph-${order.tab}`}>
            {order.shopeeStatus ?? ORDER_TAB_LABELS[order.tab]}
          </div>
          {order.readyToPost && (
            <div className="ready-tag">🏷️ Etiqueta gerada — pronto para o ponto de coleta</div>
          )}
          {order.logisticsStatus && <div className="muted">🚚 {order.logisticsStatus}</div>}
          {order.labelGeneratedAt && <div className="muted">Etiqueta gerada em {new Date(order.labelGeneratedAt).toLocaleDateString('pt-BR')}</div>}
        </section>

        <section>
          <h3>Produção por item</h3>
          {production.length === 0 && <p className="muted">Nenhum item com fluxo de produção cadastrado.</p>}
          {production.map((item) => {
            const key = `${item.itemId}:${item.modelId}`
            return <div className="stage-card" key={key}>
              <strong>{item.quantity}× {item.itemName}</strong>
              {item.modelName && <div className="muted">{item.modelName}</div>}
              <div className="muted">{item.flowName}</div>
              <div className="phase-badge" style={{ borderLeft: `4px solid ${item.stage.color ?? '#64748b'}` }}>{item.stage.name}</div>
              <div className="action-buttons">
                {item.stage.actions.map((action) => <button key={action.id} type="button"
                  disabled={productionBusy === key}
                  onClick={() => void runProductionAction(item, action.kind)}>
                  {productionBusy === key ? 'Aguarde…' : action.label}
                </button>)}
              </div>
            </div>
          })}
          {productionError && <p className="form-error">{productionError}</p>}
        </section>

        <section>
          <h3>Personalização</h3>
          {order.items.some((item) => item.templateKey) && <button type="button" className="order-art-button" onClick={() => onEditArt(orderSn)}>Editar arte deste pedido</button>}
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
          <div className="section-title-row">
            <h3>Recebimento</h3>
            <button
              className="small-btn"
              title="Consulta o extrato deste pedido na Shopee agora"
              disabled={refreshingIncome}
              onClick={async () => {
                setRefreshingIncome(true)
                try {
                  const r = await window.api.orders.refreshIncome(orderSn)
                  onToast(r.ok ? 'Extrato atualizado' : `Erro: ${r.error}`)
                  if (r.ok) await load()
                } finally {
                  setRefreshingIncome(false)
                }
              }}
            >
              {refreshingIncome ? '⏳ Atualizando pagamento…' : '💰 Sincronizar pagamento'}
            </button>
          </div>
          {!order.recebimento && (
            <p className="muted">Extrato ainda não consultado para este pedido.</p>
          )}
        </section>

        {order.recebimento && (
          <section>
            <table className="extrato">
              <tbody>
                <Linha
                  rotulo="Preço original dos produtos"
                  valor={order.recebimento.valorProdutos}
                  sempreVisivel
                />
                <Linha rotulo="Frete pago pelo comprador" valor={order.recebimento.fretePagoComprador} />
                <Linha rotulo="Custo do frete" valor={order.recebimento.custoFrete} />
                <Linha rotulo="Subsídio de frete da Shopee" valor={order.recebimento.subsidioFreteShopee} />
                <Linha rotulo="Saldo do frete" valor={order.recebimento.valorFrete} sempreVisivel />
                <Linha
                  rotulo="Desconto de cupom"
                  valor={-Math.abs(order.recebimento.descontoCupons ?? 0)}
                  sempreVisivel
                />
                <Linha
                  rotulo="Subtotal após o cupom"
                  valor={calcularValorAposCupom(order.recebimento)}
                  sempreVisivel
                />
                <Linha rotulo="Comissão" valor={order.recebimento.taxaComissao} />
                <Linha rotulo="Taxa de serviço" valor={order.recebimento.taxaServico} />
                <Linha rotulo="Outras taxas" valor={order.recebimento.outrasTaxas} />
                <Linha
                  rotulo="Total de taxas"
                  valor={
                    order.recebimento.totalTaxas !== null
                      ? -order.recebimento.totalTaxas
                      : null
                  }
                  sempreVisivel
                />
                <tr className="extrato-total">
                  <td>Recebido</td>
                  <td className="num">
                    {order.recebimento.valorRecebido != null
                      ? `R$ ${order.recebimento.valorRecebido.toFixed(2)}`
                      : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
            <small className="muted">
              {order.recebimento.recebidoEm
                ? `Liberado em ${new Date(order.recebimento.recebidoEm).toLocaleDateString('pt-BR')}`
                : order.recebimento.previstoPara
                  ? `Ainda não caiu — previsto para ${new Date(order.recebimento.previstoPara).toLocaleDateString('pt-BR')}`
                  : 'Valor calculado pela Shopee; ainda sem data de liberação.'}
              {calcularPercentualTaxas(order.recebimento) != null
                ? ` · taxas somam ${calcularPercentualTaxas(order.recebimento)}% dos produtos após o cupom`
                : ''}
            </small>
          </section>
        )}

        <section>
          <h3>Itens</h3>
          <ul className="item-list">
            {order.items.length === 0 && <li className="muted">Sem itens sincronizados</li>}
            {order.items.map((i) => (
              <li key={i.id}>
                <b>{i.quantity}x</b> {i.itemName}
                {i.modelName && <span className="muted"> — {i.modelName}</span>}
                {i.lacos && <span className="muted"> · {i.quantity * i.lacos} laços</span>}
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
              disabled={refreshingTracking}
              onClick={async () => {
                setRefreshingTracking(true)
                try {
                  const r = await window.api.orders.refreshTracking(orderSn)
                  if (!r.ok) onToast(`Erro no rastreio: ${r.error}`)
                  else
                    onToast(
                      r.newEvents > 0
                        ? `${r.newEvents} novo(s) evento(s): ${r.latestStatus}`
                        : 'Rastreio sem novidades'
                    )
                  if (r.ok) await load()
                } finally {
                  setRefreshingTracking(false)
                }
              }}
            >
              {refreshingTracking ? '⏳ Atualizando rastreio…' : '🔄 Atualizar rastreio'}
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
