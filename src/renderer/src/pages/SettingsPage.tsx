import { useEffect, useState } from 'react'
import type { ActionResult, AppSettings, UpdateStatus } from '@shared/types'
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
  const [syncingAll, setSyncingAll] = useState(false)
  const [syncAllResult, setSyncAllResult] = useState<string | null>(null)
  const [dumpInfo, setDumpInfo] = useState<{ path: string; count: number } | null>(null)
  const [probeResult, setProbeResult] = useState<ActionResult | null>(null)
  const [tursoUrl, setTursoUrl] = useState('')
  const [tursoPlatformToken, setTursoPlatformToken] = useState('')
  const [savingTurso, setSavingTurso] = useState(false)
  const [tursoResult, setTursoResult] = useState<string | null>(null)
  const [boundShopId, setBoundShopId] = useState<string | null>(null)
  const [shopeeBindError, setShopeeBindError] = useState<string | null>(null)
  const [browserConnecting, setBrowserConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [shopeeNotice, setShopeeNotice] = useState<string | null>(null)
  const [authMode, setAuthMode] = useState<'app' | 'chrome'>('app')

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    void window.api.app.version().then(setVersion)
    void window.api.updates.status().then(setUpdateStatus)
    void window.api.shopee.dumpInfo().then(setDumpInfo)
    void window.api.shopee.browserStatus().then((status) => setAuthMode(status.mode))
    void window.api.database.status().then((status) => {
      setTursoUrl(status.url ?? '')
      setBoundShopId(status.shopeeShopId ?? null)
    })
    return window.api.updates.onStatus(setUpdateStatus)
  }, [])

  if (!settings) return <div className="page" />

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
          Por padrão o app só sincroniza quando você clica em <b>Sincronizar</b>. As APIs da
          Shopee são internas e sem cota publicada — ligue o automático só se precisar.
        </p>
        <p className="muted">
          <b>Sincronizar</b> atualiza todos os pedidos em A Enviar e Enviado na Shopee, além dos
          pedidos que continuam em aberto neste banco. Para importar o histórico inteiro, use o
          botão abaixo.
        </p>

        <div className="action-buttons">
          <button
            disabled={syncingAll}
            onClick={async () => {
              setSyncingAll(true)
              setSyncAllResult(null)
              const r = await window.api.shopee.syncAll()
              setSyncAllResult(
                r.ok
                  ? `${r.ordersUpserted} pedidos sincronizados (${r.newOrders} novos)`
                  : `Erro: ${r.error}`
              )
              setSyncingAll(false)
              void window.api.shopee.dumpInfo().then(setDumpInfo)
            }}
          >
            {syncingAll ? 'Sincronizando tudo… (pode demorar)' : '⤓ Sincronizar tudo'}
          </button>
          {dumpInfo && dumpInfo.count > 0 && (
            <>
              <button
                disabled={syncingAll}
                title="Relê os JSON salvos e reaplica o parsing — sem consultar a Shopee"
                onClick={async () => {
                  const r = await window.api.shopee.reprocess()
                  setSyncAllResult(`${r.aplicados} pedidos reprocessados do disco (sem rede)`)
                }}
              >
                ♻ Reprocessar salvos ({dumpInfo.count})
              </button>
              <button onClick={() => window.api.shell.openPath(dumpInfo.path)}>
                📂 Abrir pasta dos JSON
              </button>
            </>
          )}
        </div>
        <div className="action-buttons">
          <button
            title="Relê os extratos já guardados e reaplica a interpretação — sem rede"
            onClick={async () => {
              const r = await window.api.orders.reprocessarExtratos()
              setSyncAllResult(
                `${r.lidos} extratos relidos do disco · ${r.corrigidos} corrigidos (sem rede)`
              )
            }}
          >
            ♻ Reprocessar extratos salvos
          </button>
        </div>
        <BarraProgresso />
        {syncAllResult && <small className="muted">{syncAllResult}</small>}
        <small className="muted">
          A carga completa percorre todas as páginas e grava o JSON cru de cada pedido em disco,
          o que permite conferir dados sem consultar a Shopee de novo.
        </small>

        <div className="setting-row">
          <label>
            <input
              type="checkbox"
              checked={settings.syncTracking}
              onChange={(e) => update({ syncTracking: e.target.checked })}
            />{' '}
            Sincronizar enviados (rastreio)
          </label>
          <small className="muted">
            Consulta o rastreio de cada pedido enviado. É uma chamada por pedido, então é a etapa
            mais demorada.
          </small>
        </div>
        <div className="setting-row">
          <label>
            <input
              type="checkbox"
              checked={settings.syncPayments}
              onChange={(e) => update({ syncPayments: e.target.checked })}
            />{' '}
            Sincronizar pagamentos
          </label>
          <small className="muted">
            Busca o extrato de quem ainda não tem, e reconsulta os enviados cujo dinheiro não
            caiu — os únicos que podem mudar.
          </small>
        </div>
        <div className="setting-row">
          <label>
            <input
              type="checkbox"
              checked={settings.autoSyncEnabled}
              onChange={(e) => update({ autoSyncEnabled: e.target.checked })}
            />{' '}
            Sincronizar automaticamente
          </label>
        </div>
        {settings.autoSyncEnabled && (
          <div className="setting-row">
            <label>Intervalo (minutos)</label>
            <input
              type="number"
              min={5}
              max={240}
              value={settings.syncIntervalMinutes}
              onChange={(e) => update({ syncIntervalMinutes: Number(e.target.value) || 15 })}
              style={{ width: 100 }}
            />
          </div>
        )}
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
