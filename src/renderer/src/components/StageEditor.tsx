import { useEffect, useState } from 'react'
import type { ProductionFlow } from '@shared/types'

export default function StageEditor(): React.JSX.Element {
  const [flows, setFlows] = useState<ProductionFlow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.production.flows().then(setFlows).catch((cause) => setError(String(cause)))
  }, [])

  const update = async (operation: () => Promise<ProductionFlow[]>): Promise<void> => {
    setBusy(true)
    setError(null)
    try { setFlows(await operation()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  return <div className="stage-editor">
    <p className="muted">Fluxos usados nos itens dos pedidos. Altere os nomes e as cores conforme sua rotina.</p>
    {flows.map((flow) => <section key={flow.id}>
      <h3>{flow.name}</h3>
      {flow.stages.map((stage) => <div className="stage-card" key={stage.id}>
        <div className="stage-head">
          <input type="color" value={stage.color ?? '#64748b'} disabled={busy}
            title="Cor da etapa" onChange={(event) => void update(() => window.api.production.updateStage(stage.id, { color: event.target.value }))} />
          <input className="stage-name" key={`${stage.id}-${stage.name}`} defaultValue={stage.name} disabled={busy}
            aria-label={`Nome da etapa ${stage.name}`} onBlur={(event) => {
              if (event.target.value.trim() !== stage.name) void update(() => window.api.production.updateStage(stage.id, { name: event.target.value }))
            }} />
        </div>
        <div className="stage-actions">
          {stage.actions.map((action) => <label key={action.id} className="action-chip">
            <span className="muted">Botão</span>
            <input key={`${action.id}-${action.label}`} defaultValue={action.label} disabled={busy}
              aria-label={`Nome da ação ${action.label}`} onBlur={(event) => {
                if (event.target.value.trim() !== action.label) void update(() => window.api.production.updateAction(action.id, event.target.value))
              }} />
          </label>)}
          {stage.actions.length === 0 && <span className="muted">Etapa final</span>}
        </div>
      </div>)}
    </section>)}
    {error && <p className="form-error">{error}</p>}
  </div>
}
