import { useEffect, useState } from 'react'
import type { ActionResult, AppSettings, UpdateStatus } from '@shared/types'
import StageEditor from '../components/StageEditor'

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
  const [probeResult, setProbeResult] = useState<ActionResult | null>(null)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    void window.api.app.version().then(setVersion)
    void window.api.updates.status().then(setUpdateStatus)
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
        <h3>Conexão Shopee</h3>
        <p className="muted">
          Abre a janela do Seller Center para você entrar com sua conta. A sessão fica salva
          neste computador — depois de logar, feche a janela e clique em Sincronizar.
        </p>
        <div className="action-buttons">
          <button
            onClick={async () => {
              await window.api.shopee.connect()
              onStatusChange()
            }}
          >
            🔑 Conectar / abrir Seller Center
          </button>
          <button
            className="danger"
            onClick={async () => {
              await window.api.shopee.disconnect()
              onStatusChange()
            }}
          >
            Desconectar (limpar sessão)
          </button>
        </div>
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
        <div className="setting-row">
          <label>Domínio Shopee</label>
          <input
            value={settings.shopeeBaseDomain}
            onChange={(e) => setSettings({ ...settings, shopeeBaseDomain: e.target.value })}
            onBlur={(e) => update({ shopeeBaseDomain: e.target.value })}
            style={{ width: 240 }}
          />
          <small className="muted">Padrão: shopee.com.br</small>
        </div>
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
        <div className="setting-row">
          <label>Repositório de atualizações (opcional)</label>
          <input
            value={settings.githubRepo}
            onChange={(e) => setSettings({ ...settings, githubRepo: e.target.value })}
            onBlur={(e) => update({ githubRepo: e.target.value.trim() })}
            style={{ width: 300 }}
            placeholder="dono/repo — vazio usa o do instalador"
          />
          <small className="muted">
            Só preencha para apontar o app para outro repositório sem reinstalar.
          </small>
        </div>
      </section>
    </div>
  )
}
