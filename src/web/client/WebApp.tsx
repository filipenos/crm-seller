import { useState } from 'react'
import DashboardPage from '../../renderer/src/pages/DashboardPage'
import WebOrdersPage from './WebOrdersPage'
import WebProductionPage from './WebProductionPage'

type Page = 'dashboard' | 'orders' | 'production'

export default function WebApp(): React.JSX.Element {
  const [page, setPage] = useState<Page>('dashboard')
  return <div className="app web-app">
    <aside className="sidebar">
      <div className="brand"><strong>CRM Seller</strong><small>Consulta online</small></div>
      <nav>
        <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>Painel</button>
        <button className={page === 'orders' ? 'active' : ''} onClick={() => setPage('orders')}>Pedidos</button>
        <button className={page === 'production' ? 'active' : ''} onClick={() => setPage('production')}>Fabricação</button>
      </nav>
      <div className="sidebar-footer"><small>Dados sincronizados pelo aplicativo desktop</small></div>
    </aside>
    <main className="content">
      {page === 'dashboard' && <DashboardPage />}
      {page === 'orders' && <WebOrdersPage />}
      {page === 'production' && <WebProductionPage />}
    </main>
  </div>
}
