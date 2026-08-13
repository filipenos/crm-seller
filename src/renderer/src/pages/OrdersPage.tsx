import { useEffect, useState } from 'react'
import type { Order, OrderCounts, OrderTab } from '@shared/types'
import { MAIN_TABS, ORDER_TAB_LABELS } from '@shared/types'
import OrderDetail from '../components/OrderDetail'
import BarraProgresso from '../components/BarraProgresso'

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
  const [counts, setCounts] = useState<OrderCounts | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    void window.api.orders.list({ tab: tabFilter, search }).then(setOrders)
    void window.api.orders.tabCounts().then(setCounts)
  }, [tabFilter, search, dataVersion])

  const refresh = (): void => {
    void window.api.orders.list({ tab: tabFilter, search }).then(setOrders)
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

  /** Cada aba tem a operação em lote que faz sentido nela. */
  const acaoDaAba = (): { rotulo: string; titulo: string; rodar: () => Promise<unknown> } | null => {
    if (tabFilter === 'ENVIADO') {
      return {
        rotulo: `🔄 Atualizar rastreios (${counts?.tabs.ENVIADO ?? 0})`,
        titulo: 'Consulta o rastreio de todos os pedidos enviados, um a um',
        rodar: () => window.api.orders.atualizarRastreios('ENVIADO')
      }
    }
    if (tabFilter === 'CONCLUIDO' && (counts?.semExtrato ?? 0) > 0) {
      return {
        rotulo: `💰 Buscar valores recebidos (${counts?.semExtrato})`,
        titulo: 'Busca o extrato dos concluídos que ainda não têm — valor de pedido concluído não muda',
        rodar: () => window.api.orders.buscarExtratos('CONCLUIDO')
      }
    }
    return null
  }
  const acao = acaoDaAba()

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
          title="Sem prefixo procura em todos os campos. Com prefixo restringe: tema:kpop, nick:comprador, rastreio:BR123, url:2390000000000"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>

      <div className="status-tabs">
        <button
          className={tabFilter === 'TODOS' ? 'active' : ''}
          onClick={() => setTabFilter('TODOS')}
        >
          Todos ({total})
        </button>
        {MAIN_TABS.map((t) => (
          <button
            key={t}
            className={tabFilter === t ? 'active' : ''}
            onClick={() => setTabFilter(t)}
          >
            {ORDER_TAB_LABELS[t]} ({counts?.tabs[t] ?? 0})
          </button>
        ))}
        <button
          className={tabFilter === 'CANCELADO' ? 'active' : ''}
          onClick={() => setTabFilter('CANCELADO')}
        >
          {ORDER_TAB_LABELS.CANCELADO} ({counts?.tabs.CANCELADO ?? 0})
        </button>
      </div>

      {acao && (
        <div className="acoes-da-aba">
          <button
            title={acao.titulo}
            onClick={async () => {
              const r = await acao.rodar()
              const res = r as { feitos: number; cancelado: boolean; erros: number }
              showToast(
                `${res.feitos} processados${res.cancelado ? ' (parado por você)' : ''}` +
                  (res.erros > 0 ? ` · ${res.erros} falharam` : '')
              )
              refresh()
            }}
          >
            {acao.rotulo}
          </button>
        </div>
      )}
      <BarraProgresso />

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
                      {o.recebimento.totalTaxas != null && o.totalAmount ? (
                        <div>
                          <small className="muted" title="Comissão + serviço + outras taxas">
                            taxas {Math.round((o.recebimento.totalTaxas / o.totalAmount) * 100)}%
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
