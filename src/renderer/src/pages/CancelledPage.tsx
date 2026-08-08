import { useEffect, useState } from 'react'
import type { Order } from '@shared/types'

interface Props {
  dataVersion: number
}

/**
 * Cancelados em página separada, como no Seller Center.
 *
 * São 85 na conta real e nenhum pede ação — deixá-los na listagem principal só
 * afastaria os poucos pedidos que precisam de trabalho hoje.
 */
export default function CancelledPage({ dataVersion }: Props): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [search, setSearch] = useState('')

  useEffect(() => {
    void window.api.orders.list({ tab: 'CANCELADO', search }).then(setOrders)
  }, [search, dataVersion])

  return (
    <div className="page orders-page">
      <header className="page-header">
        <h1>Cancelados</h1>
        <input
          className="search"
          placeholder="Buscar por pedido, comprador ou nome…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>

      {orders.length === 0 ? (
        <div className="empty">Nenhum pedido cancelado.</div>
      ) : (
        <>
          <p className="muted">
            {orders.length} pedido{orders.length > 1 ? 's' : ''} cancelado
            {orders.length > 1 ? 's' : ''} ou devolvido{orders.length > 1 ? 's' : ''}.
          </p>
          <table className="orders-table">
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Data</th>
                <th>Comprador</th>
                <th>Itens</th>
                <th>Valor</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.orderSn}>
                  <td className="mono">{o.orderSn}</td>
                  <td>
                    {o.createdAtShopee
                      ? new Date(o.createdAtShopee).toLocaleDateString('pt-BR')
                      : '—'}
                  </td>
                  <td>{o.buyerName ?? o.buyerUsername ?? '-'}</td>
                  <td>
                    {o.items.length === 0
                      ? '-'
                      : o.items.map((i) => `${i.quantity}x ${i.itemName}`).join(', ')}
                  </td>
                  <td>{o.totalAmount != null ? `R$ ${o.totalAmount.toFixed(2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
