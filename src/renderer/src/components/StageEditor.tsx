import { useEffect, useState } from 'react'
import type { StageActionKind, WorkflowStage } from '@shared/types'
import { STAGE_ACTION_KINDS, STAGE_ACTION_LABELS } from '@shared/types'

/**
 * Cadastro das etapas de produção e das ações de cada uma.
 *
 * As ações são um conjunto fechado (cada uma dispara código do app); o que se
 * cadastra é quais aparecem em cada etapa, com que rótulo e em que ordem.
 */
export default function StageEditor(): React.JSX.Element {
  const [stages, setStages] = useState<WorkflowStage[]>([])
  const [novaEtapa, setNovaEtapa] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    void window.api.stages.list().then(setStages)
  }, [])

  const run = async (fn: () => Promise<WorkflowStage[]>): Promise<void> => {
    try {
      setErro(null)
      setStages(await fn())
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    }
  }

  const mover = (index: number, delta: number): void => {
    const alvo = index + delta
    if (alvo < 0 || alvo >= stages.length) return
    const ids = stages.map((s) => s.id)
    ;[ids[index], ids[alvo]] = [ids[alvo], ids[index]]
    void run(() => window.api.stages.reorder(ids))
  }

  return (
    <div className="stage-editor">
      {stages.map((stage, index) => (
        <div className="stage-card" key={stage.id}>
          <div className="stage-head">
            <input
              type="color"
              value={stage.color ?? '#64748b'}
              title="Cor da etapa"
              onChange={(e) => run(() => window.api.stages.update(stage.id, { color: e.target.value }))}
            />
            <input
              className="stage-name"
              defaultValue={stage.name}
              onBlur={(e) => {
                if (e.target.value.trim() !== stage.name) {
                  void run(() => window.api.stages.update(stage.id, { name: e.target.value }))
                }
              }}
            />
            <div className="stage-head-actions">
              <button title="Subir" disabled={index === 0} onClick={() => mover(index, -1)}>
                ↑
              </button>
              <button
                title="Descer"
                disabled={index === stages.length - 1}
                onClick={() => mover(index, 1)}
              >
                ↓
              </button>
              <button
                className="danger"
                title="Remover etapa (os pedidos dela voltam para a primeira)"
                onClick={() => run(() => window.api.stages.remove(stage.id))}
              >
                ✕
              </button>
            </div>
          </div>

          <div className="stage-actions">
            {stage.actions.length === 0 && (
              <span className="muted">Nenhuma ação — o pedido só troca de etapa pelo seletor.</span>
            )}
            {stage.actions.map((action) => (
              <span className="action-chip" key={action.id}>
                {action.label}
                <button
                  title="Remover ação"
                  onClick={() => run(() => window.api.stages.removeAction(action.id))}
                >
                  ✕
                </button>
              </span>
            ))}
            <select
              value=""
              onChange={(e) => {
                const kind = e.target.value as StageActionKind
                if (!kind) return
                void run(() =>
                  window.api.stages.addAction(stage.id, kind, STAGE_ACTION_LABELS[kind])
                )
              }}
            >
              <option value="">+ ação…</option>
              {STAGE_ACTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {STAGE_ACTION_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}

      <div className="field-row">
        <input
          placeholder="Nome da nova etapa"
          value={novaEtapa}
          onChange={(e) => setNovaEtapa(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && novaEtapa.trim()) {
              void run(() => window.api.stages.create(novaEtapa, null))
              setNovaEtapa('')
            }
          }}
        />
        <button
          disabled={!novaEtapa.trim()}
          onClick={() => {
            void run(() => window.api.stages.create(novaEtapa, null))
            setNovaEtapa('')
          }}
        >
          + Adicionar etapa
        </button>
      </div>
      {erro && <small className="muted">⚠ {erro}</small>}
    </div>
  )
}
