import { useState } from 'react'

interface Props {
  initialUrl?: string | null
  initialError?: string
  onConfigured: () => void
}

export default function DatabaseSetupPage({ initialUrl, initialError, onConfigured }: Props): React.JSX.Element {
  const [url, setUrl] = useState(initialUrl ?? '')
  const [authToken, setAuthToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(initialError ?? null)

  const configure = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await window.api.database.configure({ url, authToken })
      onConfigured()
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="database-setup">
      <form className="database-setup-card" onSubmit={(event) => void configure(event)}>
        <div className="database-setup-icon">☁</div>
        <h1>Conecte seu banco Turso</h1>
        <p className="muted">
          O CRM Seller guarda seus dados no seu próprio banco. Crie um banco no Turso e cole
          abaixo a URL e um token de acesso.
        </p>

        <label htmlFor="turso-url">URL do banco</label>
        <input
          id="turso-url"
          type="url"
          required
          autoFocus
          spellCheck={false}
          placeholder="libsql://meu-banco-minha-conta.turso.io"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />

        <label htmlFor="turso-token">Token de autenticação</label>
        <input
          id="turso-token"
          type="password"
          required
          autoComplete="off"
          placeholder="Cole o token gerado pelo Turso"
          value={authToken}
          onChange={(event) => setAuthToken(event.target.value)}
        />
        <small className="muted">
          O token fica criptografado neste computador e nunca é salvo no banco ou no projeto.
        </small>

        {error && <div className="database-setup-error">⚠ {error}</div>}
        <button type="submit" disabled={saving}>
          {saving ? 'Testando conexão…' : 'Testar e conectar'}
        </button>
        <button
          className="link-button"
          type="button"
          onClick={() => void window.api.shell.openExternal('https://turso.tech')}
        >
          Ainda não tenho um banco Turso
        </button>
      </form>
    </main>
  )
}
