import { useCallback, useEffect, useState } from 'react'
import type { ProgressoLote, ShopeeConnectionStatus, SyncResult, UpdateStatus } from '@shared/types'
import DashboardPage from './pages/DashboardPage'
import WorkPage from './pages/WorkPage'
import OrdersPage from './pages/OrdersPage'
import ProdutosPage from './pages/ProdutosPage'
import ProducaoPage from './pages/ProducaoPage'
import ActivityPage from './pages/ActivityPage'
import SettingsPage from './pages/SettingsPage'
import BarraProgresso from './components/BarraProgresso'
import DatabaseSetupPage from './pages/DatabaseSetupPage'
import OrdersSyncPage from './pages/OrdersSyncPage'
import PerformancePage from './pages/PerformancePage'
import ManagementReportPage from './pages/ManagementReportPage'
import ArtEditorPage from './pages/ArtEditorPage'

type Page = 'home' | 'work' | 'orders' | 'produtos' | 'performance' | 'report' | 'producao' | 'art' | 'activity' | 'settings'

export default function App(): React.JSX.Element {
  const [database, setDatabase] = useState<{
    configured: boolean
    ready?: boolean
    url: string | null
    error?: string
    shopeeShopId?: string | null
  } | null>(null)
  const [page, setPage] = useState<Page>('home')
  const [ordersBuyer, setOrdersBuyer] = useState<string | null>(null)
  const [artOrderSn, setArtOrderSn] = useState<string | null>(null)
  const [artReturnPage, setArtReturnPage] = useState<'orders' | 'work'>('orders')
  const [status, setStatus] = useState<ShopeeConnectionStatus | null>(null)
  const [lastSync, setLastSync] = useState<SyncResult | null>(null)
  const [dataVersion, setDataVersion] = useState(0)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [unseenEvents, setUnseenEvents] = useState(0)
  const [syncProgress, setSyncProgress] = useState<ProgressoLote | null>(null)
  const [syncStarting, setSyncStarting] = useState(false)

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
    if (!database?.configured || database.ready === false) return
    void refreshStatus()
    void refreshUnseen()
    const offStatus = window.api.shopee.onStatusChanged(setStatus)
    const offData = window.api.events.onDataChanged(() => {
      setDataVersion((v) => v + 1)
      void refreshUnseen()
    })
    void window.api.lote.progresso().then(setSyncProgress)
    const offProgress = window.api.lote.onProgresso(setSyncProgress)
    void window.api.updates.status().then(setUpdate)
    const offUpdate = window.api.updates.onStatus((next) => {
      setUpdate(next)
      if (next.state === 'downloaded') setUpdateDismissed(false)
    })
    return () => {
      offStatus()
      offData()
      offProgress()
      offUpdate()
    }
  }, [database?.configured, database?.ready, refreshStatus, refreshUnseen])

  if (!database) return <div className="app-loading">Abrindo CRM Seller…</div>
  if (database.configured && database.ready === false) {
    return <main className="database-setup"><div className="database-setup-card">
      <div className="database-setup-icon">☁</div>
      <h1>Não foi possível conectar ao Turso</h1>
      <p className="muted">Sua configuração continua salva neste computador. Verifique a conexão e tente novamente.</p>
      {database.error && <div className="database-setup-error">⚠ {database.error}</div>}
      <button onClick={() => {
        setDatabase(null)
        void window.api.database.status().then(setDatabase).catch((reason) => {
          setDatabase({ configured: true, ready: false, url: database.url, error: String(reason) })
        })
      }}>Tentar novamente</button>
    </div></main>
  }
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
    setSyncStarting(true)
    try {
      const result = await window.api.shopee.sync()
      setLastSync(result)
    } finally {
      setSyncStarting(false)
    }
  }

  const syncActive = syncStarting || Boolean(status?.syncing) || Boolean(syncProgress?.rodando)

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
          <button className={page === 'work' ? 'active' : ''} onClick={() => setPage('work')}>
            Meu trabalho
          </button>
          <button className={page === 'orders' ? 'active' : ''} onClick={() => { setOrdersBuyer(null); setPage('orders') }}>
            Pedidos
          </button>
          <button className={page === 'produtos' ? 'active' : ''} onClick={() => setPage('produtos')}>
            Produtos
          </button>
          <button className={page === 'performance' ? 'active' : ''} onClick={() => setPage('performance')}>
            Desempenho
          </button>
          <button className={page === 'report' ? 'active' : ''} onClick={() => setPage('report')}>
            Relatório gerencial
          </button>
          <button className={page === 'producao' ? 'active' : ''} onClick={() => setPage('producao')}>
            Composição
          </button>
          <button className={page === 'art' ? 'active' : ''} onClick={() => { setArtOrderSn(null); setPage('art') }}>
            Editor de artes
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
        <button className="sync-btn" onClick={handleSync} disabled={syncActive}>
          {syncActive ? 'Sincronizando…' : '↻ Sincronizar'}
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
        {page !== 'orders' && <BarraProgresso />}
        {page === 'home' && <DashboardPage dataVersion={dataVersion} />}
        {page === 'work' && <WorkPage dataVersion={dataVersion} onEditArt={(orderSn) => { setArtOrderSn(orderSn); setArtReturnPage('work'); setPage('art') }} />}
        {page === 'orders' && (syncActive
          ? <OrdersSyncPage progress={syncProgress} starting={syncStarting} />
          : <OrdersPage dataVersion={dataVersion} initialBuyerUsername={ordersBuyer} onEditArt={(orderSn) => { setArtOrderSn(orderSn); setArtReturnPage('orders'); setPage('art') }} />)}
        {page === 'produtos' && <ProdutosPage dataVersion={dataVersion} />}
        {page === 'performance' && <PerformancePage />}
        {page === 'report' && <ManagementReportPage onOpenBuyer={(username) => { setOrdersBuyer(username); setPage('orders') }} />}
        {page === 'producao' && <ProducaoPage dataVersion={dataVersion} />}
        {page === 'art' && <ArtEditorPage orderSn={artOrderSn} onBack={artOrderSn ? () => { setArtOrderSn(null); setPage(artReturnPage) } : undefined} />}
        {page === 'activity' && (
          <ActivityPage dataVersion={dataVersion} onSeen={() => void refreshUnseen()} />
        )}
        {page === 'settings' && <SettingsPage onStatusChange={refreshStatus} />}
      </main>
    </div>
  )
}
