import { getAsyncDb } from '../db'
import type { ProductionActionKind, ProductionFlow, ProductionItem } from '@shared/types'

interface FlowRow { id: number; code: string; name: string; product_kind: string }
interface StageRow { id: number; flow_id: number; code: string; name: string; position: number; color: string | null }
interface ActionRow { id: number; stage_id: number; kind: ProductionActionKind; label: string; position: number }
interface ItemRow {
  order_sn: string; item_id: string; model_id: string; item_name: string; model_name: string | null
  quantity: number; template_key: string | null; flow_id: number; stage_id: number | null; art_generated_at: number | null
}

function mapFlows(rawFlows: unknown[], rawStages: unknown[], rawActions: unknown[]): ProductionFlow[] {
  const flows = rawFlows as FlowRow[]
  const stages = rawStages as StageRow[]
  const actions = rawActions as ActionRow[]
  return flows.map((flow) => ({
    id: flow.id, code: flow.code, name: flow.name, productKind: flow.product_kind,
    stages: stages.filter((stage) => stage.flow_id === flow.id).map((stage) => ({
      id: stage.id, code: stage.code, name: stage.name, position: stage.position, color: stage.color,
      actions: actions.filter((action) => action.stage_id === stage.id).map((action) => ({
        id: action.id, kind: action.kind, label: action.label, position: action.position
      }))
    }))
  }))
}

const flowQueries = [
  { sql: 'SELECT id, code, name, product_kind FROM production_flows ORDER BY id' },
  { sql: 'SELECT id, flow_id, code, name, position, color FROM production_stages ORDER BY flow_id, position, id' },
  { sql: 'SELECT id, stage_id, kind, label, position FROM production_stage_actions ORDER BY stage_id, position, id' }
]

export async function listProductionFlows(): Promise<ProductionFlow[]> {
  const [rawFlows, rawStages, rawActions] = await getAsyncDb().queryBatch(flowQueries)
  return mapFlows(rawFlows, rawStages, rawActions)
}

async function loadOrderProduction(orderSn: string): Promise<{ items: ProductionItem[]; flows: ProductionFlow[] }> {
  if (!orderSn.trim()) throw new Error('Pedido inválido.')
  const [rawItems, rawFlows, rawStages, rawActions] = await getAsyncDb().queryBatch([
    { sql: `SELECT i.order_sn, COALESCE(i.item_id, '') AS item_id,
      COALESCE(i.model_id, '') AS model_id, i.item_name, i.model_name, i.quantity,
      p.template_key, f.id AS flow_id, w.stage_id, w.art_generated_at
      FROM order_items i JOIN products p ON p.item_id = i.item_id
      JOIN production_flows f ON f.product_kind = p.kind
      LEFT JOIN order_item_work w ON w.order_sn = i.order_sn
        AND w.item_id = COALESCE(i.item_id, '') AND w.model_id = COALESCE(i.model_id, '')
      WHERE i.order_sn = ? ORDER BY i.id`, parameters: [orderSn] },
    ...flowQueries
  ])
  const flows = mapFlows(rawFlows, rawStages, rawActions)
  const items = (rawItems as ItemRow[]).map((row) => {
    const flow = flows.find((entry) => entry.id === row.flow_id)!
    const stage = flow.stages.find((entry) => entry.id === row.stage_id) ?? flow.stages[0]
    return {
      orderSn: row.order_sn, itemId: row.item_id, modelId: row.model_id,
      itemName: row.item_name, modelName: row.model_name, quantity: row.quantity,
      templateKey: row.template_key, flowCode: flow.code, flowName: flow.name,
      stage, artGeneratedAt: row.art_generated_at
    }
  })
  return { items, flows }
}

export async function listOrderProduction(orderSn: string): Promise<ProductionItem[]> {
  return (await loadOrderProduction(orderSn)).items
}

export async function updateProductionStage(id: number, patch: { name?: string; color?: string | null }): Promise<ProductionFlow[]> {
  if (!Number.isInteger(id) || id < 1) throw new Error('Etapa inválida.')
  const name = patch.name?.trim()
  if (patch.name !== undefined && (!name || name.length > 60)) throw new Error('Nome da etapa inválido.')
  if (patch.color !== undefined && patch.color !== null && !/^#[0-9a-fA-F]{6}$/.test(patch.color)) throw new Error('Cor inválida.')
  const statements: { sql: string; parameters: unknown[] }[] = []
  if (name) statements.push({ sql: 'UPDATE production_stages SET name = ? WHERE id = ?', parameters: [name, id] })
  if (patch.color !== undefined) statements.push({ sql: 'UPDATE production_stages SET color = ? WHERE id = ?', parameters: [patch.color, id] })
  if (statements.length) await getAsyncDb().batch(statements)
  return listProductionFlows()
}

export async function updateProductionAction(id: number, label: string): Promise<ProductionFlow[]> {
  if (!Number.isInteger(id) || id < 1 || !label.trim() || label.trim().length > 60) throw new Error('Ação inválida.')
  const statement = await getAsyncDb().prepare('UPDATE production_stage_actions SET label = ? WHERE id = ?')
  await statement.run([label.trim(), id])
  return listProductionFlows()
}

export async function actOnProductionItem(orderSn: string, itemId: string, modelId: string, kind: ProductionActionKind): Promise<ProductionItem[]> {
  const { items, flows } = await loadOrderProduction(orderSn)
  const item = items.find((entry) => entry.itemId === itemId && entry.modelId === modelId)
  if (!item) throw new Error('Item do pedido não encontrado.')
  if (!item.stage.actions.some((action) => action.kind === kind)) throw new Error('Ação indisponível nesta etapa.')
  if (kind === 'GENERATE_ART' || kind === 'EDIT_ART' || kind === 'RETRY_PRINT') return items
  if ((kind === 'APPROVE_ART' || kind === 'PRINT_ART') && !item.artGeneratedAt) throw new Error('Gere a arte antes de continuar.')
  if (kind === 'RECEIVE_DATA') {
    const row = await (await getAsyncDb().prepare('SELECT child_name FROM orders WHERE order_sn = ?')).get([orderSn]) as { child_name: string | null } | undefined
    if (!row?.child_name?.trim()) throw new Error('Informe e salve o nome da criança antes de avançar.')
  }
  const flow = flows.find((entry) => entry.code === item.flowCode)!
  const next = flow.stages.find((entry) => entry.position > item.stage.position)
  if (!next) throw new Error('Esta é a última etapa.')
  const now = Date.now()
  await getAsyncDb().batch([
    { sql: `INSERT INTO order_item_work (order_sn, item_id, model_id, stage_id, art_generated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(order_sn, item_id, model_id)
      DO UPDATE SET stage_id = excluded.stage_id, updated_at = excluded.updated_at`,
      parameters: [orderSn, itemId, modelId, next.id, item.artGeneratedAt, now] },
    { sql: `INSERT INTO order_item_work_events (order_sn, item_id, model_id, from_stage, to_stage, happened_at)
      VALUES (?, ?, ?, ?, ?, ?)`, parameters: [orderSn, itemId, modelId, item.stage.code, next.code, now] }
  ])
  return listOrderProduction(orderSn)
}

export async function markOrderArtGenerated(orderSn: string, templateKey: string): Promise<void> {
  const loaded = await loadOrderProduction(orderSn)
  const items = loaded.items.filter((item) => item.flowCode === 'boxes' && item.templateKey === templateKey)
  if (!items.length) return
  const flow = loaded.flows.find((entry) => entry.code === 'boxes')!
  const review = flow.stages.find((entry) => entry.code === 'ART_REVIEW')!
  const now = Date.now()
  await getAsyncDb().batch(items.flatMap((item) => {
    const advance = ['DATA_RECEIVED', 'ART_REVIEW', 'ART_APPROVED'].includes(item.stage.code)
    return [
      { sql: `INSERT INTO order_item_work (order_sn, item_id, model_id, stage_id, art_generated_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(order_sn, item_id, model_id)
        DO UPDATE SET stage_id = excluded.stage_id, art_generated_at = excluded.art_generated_at, updated_at = excluded.updated_at`,
        parameters: [orderSn, item.itemId, item.modelId, advance ? review.id : item.stage.id, now, now] },
      ...(advance && item.stage.code !== review.code ? [{ sql: `INSERT INTO order_item_work_events (order_sn, item_id, model_id, from_stage, to_stage, happened_at)
        VALUES (?, ?, ?, ?, ?, ?)`, parameters: [orderSn, item.itemId, item.modelId, item.stage.code, review.code, now] }] : [])
    ]
  }))
}
