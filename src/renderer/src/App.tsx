import { useCallback, useEffect, useState } from 'react'
import type { ShopeeConnectionStatus, SyncResult, UpdateStatus } from '@shared/types'
import DashboardPage from './pages/DashboardPage'
import OrdersPage from './pages/OrdersPage'
import ProdutosPage from './pages/ProdutosPage'
import ProducaoPage from './pages/ProducaoPage'
import ActivityPage from './pages/ActivityPage'
import SettingsPage from './pages/SettingsPage'
import BarraProgresso from './components/BarraProgresso'
import DatabaseSetupPage from './pages/DatabaseSetupPage'

type Page = 'home' | 'orders' | 'produtos' | 'producao' | 'activity' | 'settings'

export default function App(): React.JSX.Element {
  const [database, setDatabase] = useState<{
    configured: boolean
    url: string | null
    error?: string
    shopeeShopId?: string | null
  } | null>(null)
  const [page, setPage] = useState<Page>('home')
  const [status, setStatus] = useState<ShopeeConnectionStatus | null>(null)
  const [lastSync, setLastSync] = useState<SyncResult | null>(null)
  const [dataVersion, setDataVersion] = useState(0)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [unseenEvents, setUnseenEvents] = useState(0)

  const refreshStatus = useCallback(async () => {
    setStatus(await window.api.shopee.status())
  }, [])

  const refreshUnseen = useCallback(async () => {
    setUnseenEvents(await window.api.events.unseenCount())
  }, [])

  useEffect(() => {
    void window.api.database.status().then(setDatabase)
  }, [])

  useEffect(() => {
    if (!database?.configured) return
    void refreshStatus()
    void refreshUnseen()
    const offStatus = window.api.shopee.onStatusChanged(setStatus)
    const offData = window.api.events.onDataChanged(() => {
      setDataVersion((v) => v + 1)
      void refreshUnseen()
    })
    void window.api.updates.status().then(setUpdate)
    const offUpdate = window.api.updates.onStatus((next) => {
      setUpdate(next)
      if (next.state === 'downloaded') setUpdateDismissed(false)
    })
    return () => {
      offStatus()
      offData()
      offUpdate()
    }
  }, [database?.configured, refreshStatus, refreshUnseen])

  if (!database) return <div className="app-loading">Abrindo CRM Seller…</div>
  if (!database.configured || !database.shopeeShopId) {
    return (
      <DatabaseSetupPage
        databaseConfigured={database.configured}
        initialError={database.error}
        onConfigured={(url) => setDatabase({ configured: true, url, shopeeShopId: null })}
        onBound={(shopeeShopId) =>
          setDatabase((current) => ({
            configured: true,
            url: current?.url ?? null,
            shopeeShopId
          }))
        }
      />
    )
  }

  const handleSync = async (): Promise<void> => {
    const result = await window.api.shopee.sync()
    setLastSync(result)
    setDataVersion((v) => v + 1)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-icon">📦</span>
          <span>CRM Seller</span>
        </div>
        <nav>
          <button className={page === 'home' ? 'active' : ''} onClick={() => setPage('home')}>
            Início
          </button>
          <button className={page === 'orders' ? 'active' : ''} onClick={() => setPage('orders')}>
            Pedidos
          </button>
          <button className={page === 'produtos' ? 'active' : ''} onClick={() => setPage('produtos')}>
            Produtos
          </button>
          <button className={page === 'producao' ? 'active' : ''} onClick={() => setPage('producao')}>
            Composição
          </button>
          <button
            className={page === 'activity' ? 'active' : ''}
            onClick={() => setPage('activity')}
          >
            Atividade
            {unseenEvents > 0 && <span className="nav-badge">{unseenEvents}</span>}
          </button>
          <button
            className={page === 'settings' ? 'active' : ''}
            onClick={() => setPage('settings')}
          >
            Configurações
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className={`conn-dot ${status?.connected ? 'ok' : 'off'}`} />
          <div className="conn-info">
            <div>{status?.connected ? 'Shopee conectada' : 'Shopee desconectada'}</div>
            {status?.lastSyncAt && (
              <small>Sync: {new Date(status.lastSyncAt).toLocaleTimeString('pt-BR')}</small>
            )}
          </div>
        </div>
        <button className="sync-btn" onClick={handleSync} disabled={status?.syncing}>
          {status?.syncing ? 'Sincronizando…' : '↻ Sincronizar'}
        </button>
        {lastSync?.error && <div className="sync-error" title={lastSync.error}>⚠ {lastSync.error}</div>}
      </aside>
      <main className="content">
        {update?.state === 'downloaded' && !updateDismissed && (
          <div className="update-banner">
            <span>
              Versão <b>{update.latestVersion}</b> baixada (você está na {update.currentVersion}).
              Ela é instalada quando você fechar o app.
            </span>
            <button onClick={() => void window.api.updates.install()}>
              Reiniciar e instalar agora
            </button>
            <button className="dismiss" onClick={() => setUpdateDismissed(true)}>
              ✕
            </button>
          </div>
        )}
        {update?.state === 'downloading' && (
          <div className="update-banner">
            <span>
              Baixando a versão {update.latestVersion ?? 'nova'}
              {update.percent !== null ? ` — ${update.percent}%` : '…'}
            </span>
          </div>
        )}
        {/* Fica aqui e não na listagem: a sincronização roda em qualquer página. */}
        <BarraProgresso />
        {page === 'home' && <DashboardPage dataVersion={dataVersion} />}
        {page === 'orders' && <OrdersPage dataVersion={dataVersion} />}
        {page === 'produtos' && <ProdutosPage dataVersion={dataVersion} />}
        {page === 'producao' && <ProducaoPage dataVersion={dataVersion} />}
        {page === 'activity' && (
          <ActivityPage dataVersion={dataVersion} onSeen={() => void refreshUnseen()} />
        )}
        {page === 'settings' && <SettingsPage onStatusChange={refreshStatus} />}
      </main>
    </div>
  )
}
