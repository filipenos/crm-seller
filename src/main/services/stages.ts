import { getAsyncDb } from '../db'
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

export async function listStagesAsync(): Promise<WorkflowStage[]> {
  const db = getAsyncDb()
  const [stagesStatement, actionsStatement] = await Promise.all([
    db.prepare('SELECT id, name, position, color FROM workflow_stages ORDER BY position ASC, id ASC'),
    db.prepare('SELECT id, stage_id, label, kind, position FROM stage_actions ORDER BY position ASC, id ASC')
  ])
  const [stages, actions] = await Promise.all([
    stagesStatement.all([]) as Promise<StageRow[]>,
    actionsStatement.all([]) as Promise<ActionRow[]>
  ])
  return stages.map((stage) => ({
    id: stage.id, name: stage.name, position: stage.position, color: stage.color,
    actions: actions.filter((action) => action.stage_id === stage.id).map(rowToAction)
  }))
}

export async function createStageAsync(name: string, color: string | null): Promise<WorkflowStage[]> {
  const db = getAsyncDb()
  const maxStatement = await db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM workflow_stages')
  const max = (await maxStatement.get([])) as { p: number }
  const insert = await db.prepare('INSERT INTO workflow_stages (name, position, color) VALUES (?, ?, ?)')
  await insert.run([name.trim() || 'Nova etapa', max.p + 1, color])
  return listStagesAsync()
}

export async function updateStageAsync(
  id: number,
  patch: { name?: string; color?: string | null }
): Promise<WorkflowStage[]> {
  const db = getAsyncDb()
  if (patch.name !== undefined) {
    const update = await db.prepare('UPDATE workflow_stages SET name = ? WHERE id = ?')
    await update.run([patch.name.trim() || 'Etapa', id])
  }
  if (patch.color !== undefined) {
    const update = await db.prepare('UPDATE workflow_stages SET color = ? WHERE id = ?')
    await update.run([patch.color, id])
  }
  return listStagesAsync()
}

export async function deleteStageAsync(id: number): Promise<WorkflowStage[]> {
  const db = getAsyncDb()
  const select = await db.prepare(
    'SELECT id FROM workflow_stages WHERE id != ? ORDER BY position ASC LIMIT 1'
  )
  const remaining = (await select.get([id])) as { id: number } | undefined
  if (!remaining) throw new Error('Não dá para remover a última etapa.')
  const move = await db.prepare('UPDATE orders SET stage_id = ? WHERE stage_id = ?')
  const remove = await db.prepare('DELETE FROM workflow_stages WHERE id = ?')
  await move.run([remaining.id, id])
  await remove.run([id])
  return listStagesAsync()
}

export async function reorderStagesAsync(orderedIds: number[]): Promise<WorkflowStage[]> {
  const update = await getAsyncDb().prepare('UPDATE workflow_stages SET position = ? WHERE id = ?')
  for (let index = 0; index < orderedIds.length; index++) {
    await update.run([index + 1, orderedIds[index]])
  }
  return listStagesAsync()
}

export async function addActionAsync(
  stageId: number,
  kind: StageActionKind,
  label: string
): Promise<WorkflowStage[]> {
  if (!(STAGE_ACTION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Ação desconhecida: ${kind}`)
  }
  const db = getAsyncDb()
  const maxStatement = await db.prepare(
    'SELECT COALESCE(MAX(position), 0) AS p FROM stage_actions WHERE stage_id = ?'
  )
  const max = (await maxStatement.get([stageId])) as { p: number }
  const insert = await db.prepare(
    'INSERT INTO stage_actions (stage_id, label, kind, position) VALUES (?, ?, ?, ?)'
  )
  await insert.run([stageId, label.trim() || kind, kind, max.p + 1])
  return listStagesAsync()
}

export async function removeActionAsync(actionId: number): Promise<WorkflowStage[]> {
  const statement = await getAsyncDb().prepare('DELETE FROM stage_actions WHERE id = ?')
  await statement.run([actionId])
  return listStagesAsync()
}

export async function nextStageIdAsync(currentStageId: number | null): Promise<number | null> {
  const stages = await listStagesAsync()
  if (stages.length === 0) return null
  if (currentStageId === null) return stages[0].id
  const index = stages.findIndex((stage) => stage.id === currentStageId)
  return index === -1 ? stages[0].id : (stages[index + 1]?.id ?? null)
}
