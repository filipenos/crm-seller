import { useState } from 'react'

interface Props {
  databaseConfigured: boolean
  initialError?: string
  onConfigured: (url: string) => void
  onBound: (shopId: string) => void
}

export default function DatabaseSetupPage({
  databaseConfigured,
  initialError,
  onConfigured,
  onBound
}: Props): React.JSX.Element {
  const [platformToken, setPlatformToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [binding, setBinding] = useState(false)
  const [started, setStarted] = useState(Boolean(initialError))

  const configure = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.database.configure({ platformToken })
      onConfigured(result.url)
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setSaving(false)
    }
  }

  if (databaseConfigured) {
    return (
      <main className="database-setup">
        <div className="database-setup-card">
          <div className="database-setup-icon">🛍</div>
          <h1>Vincule sua loja Shopee</h1>
          <p className="muted">
            Este banco será reservado para uma única loja. Antes de salvar qualquer pedido,
            confirmamos que a sessão aberta pertence à loja vinculada.
          </p>
          {error && <div className="database-setup-error">⚠ {error}</div>}
          <button
            disabled={binding}
            onClick={async () => {
              setBinding(true)
              setError(null)
              try {
                onBound(await window.api.shopee.setup())
              } catch (reason) {
                setError(String(reason instanceof Error ? reason.message : reason).replace(/^Error invoking remote method '[^']+': Error: /, ''))
              } finally {
                setBinding(false)
              }
            }}
          >
            {binding ? 'Aguardando login…' : 'Configurar Shopee'}
          </button>
          <small className="muted">
            Entre no Seller Center na janela que abrir e feche-a ao terminar. O vínculo será
            confirmado automaticamente.
          </small>
        </div>
      </main>
    )
  }

  if (!started) {
    return (
      <main className="database-setup">
        <div className="database-setup-card">
          <div className="database-setup-icon">📦</div>
          <h1>Bem-vindo ao CRM Seller</h1>
          <p className="muted">
            Primeiro vamos preparar seu banco de dados. Depois conectaremos sua loja Shopee.
          </p>
          <button onClick={() => setStarted(true)}>Começar</button>
        </div>
      </main>
    )
  }

  return (
    <main className="database-setup">
      <form className="database-setup-card" onSubmit={(event) => void configure(event)}>
        <div className="database-setup-icon">☁</div>
        <h1>Conecte seu banco Turso</h1>
        <p className="muted">
          O CRM Seller cria e configura o banco na sua própria conta Turso. Você só precisa
          informar um token da conta; o endereço e a credencial do banco são gerados pelo app.
        </p>

        <label htmlFor="turso-token">Token da conta Turso</label>
        <input
          id="turso-token"
          type="password"
          required
          autoFocus
          autoComplete="off"
          placeholder="Cole seu Platform API Token"
          value={platformToken}
          onChange={(event) => setPlatformToken(event.target.value)}
        />
        <small className="muted">
          Esse token é usado uma vez para preparar o banco e não fica salvo. O app armazena
          somente uma credencial restrita ao banco, protegida pelo sistema ou pelas permissões
          exclusivas do seu usuário.
        </small>

        {error && <div className="database-setup-error">⚠ {error}</div>}
        <button type="submit" disabled={saving}>
          {saving ? 'Preparando banco…' : 'Criar banco e continuar'}
        </button>
        <button
          className="link-button"
          type="button"
          onClick={() => void window.api.shell.openExternal('https://turso.tech')}
        >
          Ainda não tenho uma conta Turso
        </button>
      </form>
    </main>
  )
}
