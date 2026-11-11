import { useState } from 'react'
import DashboardPage from '../../renderer/src/pages/DashboardPage'
import WebOrdersPage from './WebOrdersPage'
import WebProductionPage from './WebProductionPage'
import ManagementReportPage from '../../renderer/src/pages/ManagementReportPage'

type Page = 'dashboard' | 'orders' | 'production' | 'report'

export default function WebApp(): React.JSX.Element {
  const [page, setPage] = useState<Page>('dashboard')
  const [ordersBuyer, setOrdersBuyer] = useState<string | null>(null)
  return <div className="app web-app">
    <aside className="sidebar">
      <div className="brand"><strong>CRM Seller</strong><small>Consulta online</small></div>
      <nav>
        <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>Painel</button>
        <button className={page === 'orders' ? 'active' : ''} onClick={() => { setOrdersBuyer(null); setPage('orders') }}>Pedidos</button>
        <button className={page === 'production' ? 'active' : ''} onClick={() => setPage('production')}>Fabricação</button>
        <button className={page === 'report' ? 'active' : ''} onClick={() => setPage('report')}>Relatório</button>
      </nav>
      <div className="sidebar-footer"><small>Dados sincronizados pelo aplicativo desktop</small></div>
    </aside>
    <main className="content">
      {page === 'dashboard' && <DashboardPage />}
      {page === 'orders' && <WebOrdersPage initialBuyerUsername={ordersBuyer} />}
      {page === 'production' && <WebProductionPage />}
      {page === 'report' && <ManagementReportPage onOpenBuyer={(username) => { setOrdersBuyer(username); setPage('orders') }} />}
    </main>
  </div>
}
