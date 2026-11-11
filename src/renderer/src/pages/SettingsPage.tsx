import { useEffect, useState } from 'react'
import type { ActionResult, AppSettings, PendingSyncPreview, UpdateStatus } from '@shared/types'
import StageEditor from '../components/StageEditor'
import BarraProgresso from '../components/BarraProgresso'

interface Props {
  onStatusChange: () => void
}

function describeUpdate(status: UpdateStatus | null): string {
  if (!status) return ''
  switch (status.state) {
    case 'unsupported':
      return 'Atualização automática só funciona no app instalado (aqui é modo desenvolvimento).'
    case 'checking':
      return 'Verificando…'
    case 'up-to-date':
      return `Você está na versão mais recente (${status.latestVersion ?? status.currentVersion}).`
    case 'downloading':
      return `Baixando a versão ${status.latestVersion ?? 'nova'}${status.percent !== null ? ` — ${status.percent}%` : '…'}`
    case 'downloaded':
      return `Versão ${status.latestVersion} pronta: será instalada ao fechar o app.`
    case 'error':
      return `⚠ ${status.error ?? 'falha ao verificar atualizações'}`
    default:
      return ''
  }
}

export default function SettingsPage({ onStatusChange }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)
  const [version, setVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [probing, setProbing] = useState(false)
  const [syncingMode, setSyncingMode] = useState<'recent' | 'pending' | null>(null)
  const [syncPages, setSyncPages] = useState('2')
  const [syncInProgress, setSyncInProgress] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [pendingPreview, setPendingPreview] = useState<PendingSyncPreview | null>(null)
  const [probeResult, setProbeResult] = useState<ActionResult | null>(null)
  const [tursoUrl, setTursoUrl] = useState('')
  const [tursoPlatformToken, setTursoPlatformToken] = useState('')
  const [savingTurso, setSavingTurso] = useState(false)
  const [tursoResult, setTursoResult] = useState<string | null>(null)
  const [boundShopId, setBoundShopId] = useState<string | null>(null)
  const [shopeeBindError, setShopeeBindError] = useState<string | null>(null)
  const [browserConnecting, setBrowserConnecting] = useState(false)
  const [extensionFolder, setExtensionFolder] = useState<string | null>(null)
  const [extensionError, setExtensionError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [shopeeNotice, setShopeeNotice] = useState<string | null>(null)
  const [authMode, setAuthMode] = useState<'app' | 'chrome'>('app')

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    void window.api.app.version().then(setVersion)
    void window.api.updates.status().then(setUpdateStatus)
    void window.api.shopee.browserStatus().then((status) => setAuthMode(status.mode))
    void window.api.database.status().then((status) => {
      setTursoUrl(status.url ?? '')
      setBoundShopId(status.shopeeShopId ?? null)
    })
    return window.api.updates.onStatus(setUpdateStatus)
  }, [])

  useEffect(() => {
    void window.api.shopee.status().then((status) => setSyncInProgress(status.syncing))
    return window.api.shopee.onStatusChanged((status) => setSyncInProgress(status.syncing))
  }, [])

  if (!settings) return <div className="page" />

  const pages = Number(syncPages)
  const validPages = /^\d+$/.test(syncPages) && Number.isSafeInteger(pages) && pages >= 1 && pages <= 100

  const update = async (partial: Partial<AppSettings>): Promise<void> => {
    const next = await window.api.settings.update(partial)
    setSettings(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const pickDir = async (
    key: 'ordersRootDir' | 'templatesDir',
    title: string
  ): Promise<void> => {
    const dir = await window.api.settings.pickDirectory(title)
    if (dir) await update({ [key]: dir })
  }

  return (
    <div className="page settings-page">
      <header className="page-header">
        <h1>Configurações</h1>
        {saved && <span className="saved-tag">✓ salvo</span>}
      </header>

      <section className="settings-card">
        <h3>Banco de dados Turso</h3>
        <p className="muted">
          Os dados são sincronizados com o banco criado pelo CRM Seller na sua conta Turso.
        </p>
        <div className="setting-row">
          <label>URL do banco</label>
          <input readOnly value={tursoUrl} />
        </div>
        <div className="setting-row">
          <label>Token de outra conta Turso</label>
          <input
            type="password"
            value={tursoPlatformToken}
            autoComplete="off"
            onChange={(event) => setTursoPlatformToken(event.target.value)}
            placeholder="Platform API Token"
          />
          <small className="muted">Use somente se quiser criar ou conectar o banco em outra conta.</small>
        </div>
        <div className="action-buttons">
          <button
            disabled={savingTurso || !tursoPlatformToken.trim()}
            onClick={async () => {
              setSavingTurso(true)
              setTursoResult(null)
              try {
                const result = await window.api.database.configure({
                  platformToken: tursoPlatformToken
                })
                setTursoUrl(result.url)
                setTursoPlatformToken('')
                const status = await window.api.database.status()
                setBoundShopId(status.shopeeShopId ?? null)
                setTursoResult('✓ conexão testada e salva')
              } catch (reason) {
                setTursoResult(`⚠ ${String(reason instanceof Error ? reason.message : reason)}`)
              } finally {
                setSavingTurso(false)
              }
            }}
          >
            {savingTurso ? 'Preparando…' : 'Configurar outra conta Turso'}
          </button>
        </div>
        {tursoResult && <small className="muted">{tursoResult}</small>}
      </section>

      <section className="settings-card">
        <h3>Conexão Shopee</h3>
        <p className="muted">
          Sessão em uso: {authMode === 'chrome' ? 'Chrome' : 'janela do aplicativo'}. A sessão fica salva somente neste computador.
        </p>
        <p className="muted">
          Banco vinculado à loja:{' '}
          <b>{boundShopId ? `#${boundShopId}` : 'ainda não vinculado'}</b>.
        </p>
        <p className="muted">
          Para usar o login do Chrome, abra <b>chrome://extensions</b>, ative o modo do desenvolvedor
          e escolha <b>Carregar sem compactação</b>. Selecione a pasta aberta pelo botão abaixo
          no mesmo perfil do Chrome em que você acessa a Shopee.
        </p>
        <div className="action-buttons">
          <button onClick={async () => {
            setExtensionError(null)
            try {
              setExtensionFolder(await window.api.shell.openChromeExtensionFolder())
            } catch (reason) {
              setExtensionError(String(reason instanceof Error ? reason.message : reason))
            }
          }}>Abrir pasta da extensão do Chrome</button>
        </div>
        {extensionFolder && <small className="muted">Pasta: {extensionFolder}</small>}
        {extensionError && <small className="muted">⚠ {extensionError}</small>}
        <div className="action-buttons">
          <button
            onClick={async () => {
              setShopeeBindError(null)
              try {
                setBoundShopId(await window.api.shopee.setup())
                setAuthMode('app')
                onStatusChange()
              } catch (reason) {
                setShopeeBindError(String(reason instanceof Error ? reason.message : reason).replace(/^Error invoking remote method '[^']+': Error: /, ''))
              }
            }}
          >
            🔑 Conectar / reconectar Seller Center
          </button>
          <button
            disabled={browserConnecting}
            onClick={async () => {
              setBrowserConnecting(true)
              setShopeeBindError(null)
              setAuthMode('chrome')
              try {
                setBoundShopId(await window.api.shopee.connectBrowser())
                setAuthMode('chrome')
                onStatusChange()
              } catch (reason) {
                setShopeeBindError(String(reason instanceof Error ? reason.message : reason).replace(/^Error invoking remote method '[^']+': Error: /, ''))
              } finally {
                setBrowserConnecting(false)
              }
            }}
          >
            {browserConnecting ? 'Aguardando extensão…' : 'Usar login do Chrome'}
          </button>
          {!boundShopId && (
            <button
              onClick={async () => {
                setShopeeBindError(null)
                try {
                  setBoundShopId(await window.api.shopee.bind())
                } catch (reason) {
                  setShopeeBindError(String(reason instanceof Error ? reason.message : reason))
                }
              }}
            >
              Vincular conta a este banco
            </button>
          )}
          <button
            className="danger"
            disabled={disconnecting}
            onClick={async () => {
              setDisconnecting(true)
              setShopeeNotice(null)
              try {
                await window.api.shopee.disconnect()
                setAuthMode('app')
                setShopeeNotice('Sessões locais da Shopee removidas. O vínculo do banco foi mantido.')
                onStatusChange()
              } catch (reason) {
                setShopeeNotice(`Falha ao limpar a sessão: ${String(reason instanceof Error ? reason.message : reason)}`)
              } finally {
                setDisconnecting(false)
              }
            }}
          >
            {disconnecting ? 'Limpando sessão…' : 'Desconectar (limpar sessão)'}
          </button>
        </div>
        {shopeeNotice && <small className="muted">{shopeeNotice}</small>}
        {shopeeBindError && <small className="muted">⚠ {shopeeBindError}</small>}
      </section>

      <section className="settings-card">
        <h3>Etapas de produção</h3>
        <p className="muted">
          Seu fluxo enquanto o pedido está <b>conosco</b> — depois de postado no ponto de coleta,
          quem descreve o pedido é o rastreio da Shopee. Cada etapa pode ter ações, que viram
          botões no pedido.
        </p>
        <StageEditor />
      </section>

      <section className="settings-card">
        <h3>Pastas</h3>
        <div className="setting-row">
          <label>Pasta raiz dos pedidos</label>
          <div className="field-row">
            <input readOnly value={settings.ordersRootDir} />
            <button onClick={() => pickDir('ordersRootDir', 'Pasta raiz dos pedidos')}>
              Escolher…
            </button>
          </div>
          <small className="muted">Cada pedido vira uma subpasta: “PEDIDO - NomeDaCriança”.</small>
        </div>
        <div className="setting-row">
          <label>Pasta de templates</label>
          <div className="field-row">
            <input readOnly value={settings.templatesDir} />
            <button onClick={() => pickDir('templatesDir', 'Pasta de templates')}>
              Escolher…
            </button>
          </div>
          <small className="muted">
            Todo o conteúdo desta pasta é copiado para a pasta de cada pedido. Arquivos com{' '}
            <code>{'{NOME}'}</code> no nome são renomeados com o nome da criança.
          </small>
        </div>
      </section>

      <section className="settings-card">
        <h3>Sincronização</h3>
        <p className="muted">
          Sincronizar consulta as páginas escolhidas da aba Todos e completa rastreios e
          recebimentos que ainda faltam. Sincronizar pendentes revisa os pedidos em aberto
          do banco e as consultas de rastreio e repasse ainda necessárias.
        </p>
        <div className="sync-pages-control">
          <label htmlFor="sync-pages">Páginas da aba Todos</label>
          <input id="sync-pages" type="number" min="1" max="100" step="1"
            value={syncPages} onChange={(event) => setSyncPages(event.target.value)}
            aria-invalid={!validPages} />
          <small className="muted">Até 40 pedidos por página. Padrão: 2.</small>
          {!validPages && <small className="field-error">Informe um número de 1 a 100.</small>}
        </div>
        <div className="action-buttons">
          <button disabled={syncingMode !== null || syncInProgress || !validPages} onClick={async () => {
            setSyncingMode('recent')
            setSyncResult(null)
            try {
              const result = await window.api.shopee.sync(pages)
              setSyncResult(result.error ?? `${result.ordersUpserted} pedidos atualizados (${result.newOrders} novos)`)
            } catch (error) {
              setSyncResult(String(error))
            } finally {
              setSyncingMode(null)
            }
          }}>
            {syncingMode === 'recent' ? 'Sincronizando…' : '↻ Sincronizar'}
          </button>
          <button disabled={syncingMode !== null || previewLoading || syncInProgress} onClick={async () => {
            setSyncResult(null)
            setPreviewLoading(true)
            try {
              setPendingPreview(await window.api.shopee.pendingPreview())
            } catch (error) {
              setSyncResult(String(error))
            } finally {
              setPreviewLoading(false)
            }
          }}>
            {previewLoading ? 'Preparando prévia…' : 'Sincronizar pendentes'}
          </button>
        </div>
        {pendingPreview && <div className="sync-preview" role="dialog" aria-label="Prévia da sincronização de pendentes">
          <h4>Antes de sincronizar pendentes</h4>
          <p>O banco indica estas consultas:</p>
          <ul>
            <li><strong>{pendingPreview.status}</strong> pedidos em aberto para conferir o status</li>
            <li><strong>{pendingPreview.labels}</strong> datas de etiqueta ainda faltando</li>
            <li><strong>{pendingPreview.tracking}</strong> rastreios ainda sem entrega registrada</li>
            <li><strong>{pendingPreview.payments}</strong> repasses a consultar</li>
          </ul>
          <small className="muted">As quantidades de rastreios e repasses podem mudar depois da conferência dos status.</small>
          <div className="action-buttons">
            <button className="primary" disabled={syncingMode !== null || syncInProgress} onClick={async () => {
              setPendingPreview(null)
              setSyncingMode('pending')
              setSyncResult(null)
              try {
                const result = await window.api.shopee.syncPending()
                setSyncResult(result.error ?? `${result.ordersUpserted} pedidos atualizados`)
              } catch (error) {
                setSyncResult(String(error))
              } finally {
                setSyncingMode(null)
              }
            }}>Confirmar sincronização</button>
            <button disabled={syncingMode !== null} onClick={() => setPendingPreview(null)}>Cancelar</button>
          </div>
        </div>}
        <BarraProgresso />
        {syncResult && <small className="muted">{syncResult}</small>}
      </section>

      <section className="settings-card">
        <h3>Diagnóstico das APIs da Shopee</h3>
        <p className="muted">
          Abre as páginas do Seller Center em segundo plano e anota quais APIs elas chamam. É o
          que permite corrigir o app quando a Shopee muda um endpoint — hoje avaliações,
          financeiro e rastreio ainda dependem disso. Leva alguns minutos e não altera nada na
          sua loja (só chamadas de leitura são repetidas).
        </p>
        <div className="action-buttons">
          <button
            disabled={probing}
            onClick={async () => {
              setProbing(true)
              setProbeResult(null)
              setProbeResult(await window.api.shopee.probe())
              setProbing(false)
            }}
          >
            {probing ? 'Diagnosticando… (pode demorar)' : '🔍 Rodar diagnóstico'}
          </button>
          {probeResult?.ok && probeResult.path && (
            <button onClick={() => window.api.shell.openPath(probeResult.path!)}>
              📂 Abrir pasta do diagnóstico
            </button>
          )}
        </div>
        {probeResult?.ok && (
          <small className="muted">
            Pronto. Comece pelo <code>RESUMO.md</code> na pasta gerada.
          </small>
        )}
        {probeResult && !probeResult.ok && <small className="muted">⚠ {probeResult.error}</small>}
      </section>

      <section className="settings-card">
        <h3>Atualizações</h3>
        <p className="muted">
          Versão instalada: <b>{version || '…'}</b>. O app verifica sozinho ao abrir e a cada 6
          horas, baixa em segundo plano e instala quando você fecha — não precisa reinstalar.
        </p>
        <div className="action-buttons">
          <button
            disabled={checking || updateStatus?.state === 'downloading'}
            onClick={async () => {
              setChecking(true)
              setUpdateStatus(await window.api.updates.check())
              setChecking(false)
            }}
          >
            {checking ? 'Verificando…' : '⟳ Verificar agora'}
          </button>
          {updateStatus?.state === 'downloaded' && (
            <button onClick={() => void window.api.updates.install()}>
              ⬇ Reiniciar e instalar {updateStatus.latestVersion}
            </button>
          )}
        </div>
        <small className="muted">{describeUpdate(updateStatus)}</small>
      </section>
    </div>
  )
}
