import { getDb } from '../db'
import type { StageAction, StageActionKind, WorkflowStage } from '@shared/types'
import { STAGE_ACTION_KINDS } from '@shared/types'

/**
 * Etapas de produção cadastráveis. Substituem a lista fixa que existia no
 * código: cada usuário monta o próprio fluxo, e cada etapa decide quais ações
 * aparecem no pedido.
 *
 * Estas etapas valem só enquanto o pedido está conosco — depois de postado,
 * quem descreve o pedido é a fase logística.
 */

interface StageRow {
  id: number
  name: string
  position: number
  color: string | null
}

interface ActionRow {
  id: number
  stage_id: number
  label: string
  kind: string
  position: number
}

function rowToAction(row: ActionRow): StageAction {
  return {
    id: row.id,
    stageId: row.stage_id,
    label: row.label,
    kind: row.kind as StageActionKind,
    position: row.position
  }
}

export function listStages(): WorkflowStage[] {
  const db = getDb()
  const stages = db
    .prepare('SELECT * FROM workflow_stages ORDER BY position ASC, id ASC')
    .all() as StageRow[]
  const actions = db
    .prepare('SELECT * FROM stage_actions ORDER BY position ASC, id ASC')
    .all() as ActionRow[]
  return stages.map((s) => ({
    id: s.id,
    name: s.name,
    position: s.position,
    color: s.color,
    actions: actions.filter((a) => a.stage_id === s.id).map(rowToAction)
  }))
}

export function createStage(name: string, color: string | null): WorkflowStage[] {
  const db = getDb()
  const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM workflow_stages').get() as {
    p: number
  }
  db.prepare('INSERT INTO workflow_stages (name, position, color) VALUES (?, ?, ?)').run(
    name.trim() || 'Nova etapa',
    max.p + 1,
    color
  )
  return listStages()
}

export function updateStage(
  id: number,
  patch: { name?: string; color?: string | null }
): WorkflowStage[] {
  const db = getDb()
  if (patch.name !== undefined) {
    db.prepare('UPDATE workflow_stages SET name = ? WHERE id = ?').run(
      patch.name.trim() || 'Etapa',
      id
    )
  }
  if (patch.color !== undefined) {
    db.prepare('UPDATE workflow_stages SET color = ? WHERE id = ?').run(patch.color, id)
  }
  return listStages()
}

/**
 * Remove a etapa. Os pedidos que estavam nela vão para a primeira etapa
 * restante — deixar pedido órfão de etapa esconderia trabalho em andamento.
 */
export function deleteStage(id: number): WorkflowStage[] {
  const db = getDb()
  const remaining = db
    .prepare('SELECT id FROM workflow_stages WHERE id != ? ORDER BY position ASC LIMIT 1')
    .get(id) as { id: number } | undefined
  if (!remaining) throw new Error('Não dá para remover a última etapa.')

  const tx = db.transaction(() => {
    db.prepare('UPDATE orders SET stage_id = ? WHERE stage_id = ?').run(remaining.id, id)
    db.prepare('DELETE FROM workflow_stages WHERE id = ?').run(id)
  })
  tx()
  return listStages()
}

/** Reordena pela sequência de ids recebida. */
export function reorderStages(orderedIds: number[]): WorkflowStage[] {
  const db = getDb()
  const update = db.prepare('UPDATE workflow_stages SET position = ? WHERE id = ?')
  const tx = db.transaction(() => {
    orderedIds.forEach((id, index) => update.run(index + 1, id))
  })
  tx()
  return listStages()
}

export function addAction(stageId: number, kind: StageActionKind, label: string): WorkflowStage[] {
  if (!(STAGE_ACTION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Ação desconhecida: ${kind}`)
  }
  const db = getDb()
  const max = db
    .prepare('SELECT COALESCE(MAX(position), 0) AS p FROM stage_actions WHERE stage_id = ?')
    .get(stageId) as { p: number }
  db.prepare(
    'INSERT INTO stage_actions (stage_id, label, kind, position) VALUES (?, ?, ?, ?)'
  ).run(stageId, label.trim() || kind, kind, max.p + 1)
  return listStages()
}

export function removeAction(actionId: number): WorkflowStage[] {
  getDb().prepare('DELETE FROM stage_actions WHERE id = ?').run(actionId)
  return listStages()
}

/** Próxima etapa depois da atual, ou null se já é a última. */
export function nextStageId(currentStageId: number | null): number | null {
  const stages = listStages()
  if (stages.length === 0) return null
  if (currentStageId === null) return stages[0].id
  const index = stages.findIndex((s) => s.id === currentStageId)
  if (index === -1) return stages[0].id
  return stages[index + 1]?.id ?? null
}
