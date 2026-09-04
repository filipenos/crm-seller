import { getAsyncDb, getDb } from '../../db'
import { fetchShopeeIdentity, fetchShopeeShopId } from './client'

const SETTING_KEY = 'shopeeShopId'

export function getBoundShopeeShopId(): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(SETTING_KEY) as { value: string } | undefined
  if (!row) return null
  try {
    const value = JSON.parse(row.value)
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}

async function getBoundShopeeShopIdAsync(): Promise<string | null> {
  const statement = await getAsyncDb().prepare('SELECT value FROM settings WHERE key = ?')
  const row = (await statement.get([SETTING_KEY])) as { value: string } | undefined
  if (!row) return null
  try {
    const value = JSON.parse(row.value)
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}

export async function bindCurrentShopeeAccount(): Promise<string> {
  const identity = await fetchShopeeIdentity()
  const currentShopId = identity.shopId
  const boundShopId = getBoundShopeeShopId()
  if (boundShopId && boundShopId !== currentShopId) {
    throw new Error(
      `Este banco pertence à loja Shopee ${boundShopId}, mas a sessão aberta é da loja ${currentShopId}. ` +
        'Reconecte a conta correta ou configure outro banco Turso.'
    )
  }
  if (!boundShopId) {
    const existing = getDb()
      .prepare(
        `SELECT shopee_order_id
           FROM orders
          WHERE shopee_order_id IS NOT NULL
          ORDER BY created_at_shopee DESC
          LIMIT 10`
      )
      .all() as { shopee_order_id: string }[]
    if (
      existing.length > 0 &&
      !existing.some((order) => identity.orderIds.includes(String(order.shopee_order_id)))
    ) {
      throw new Error(
        'Este banco já contém pedidos e eles não correspondem aos pedidos recentes da conta aberta. ' +
          'O vínculo foi bloqueado para não misturar dados.'
      )
    }
    getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run(SETTING_KEY, JSON.stringify(currentShopId))
  }
  return currentShopId
}

export async function assertCurrentShopeeAccount(): Promise<string> {
  const boundShopId = await getBoundShopeeShopIdAsync()
  if (!boundShopId) {
    throw new Error('Vincule esta conta Shopee ao banco Turso antes de sincronizar.')
  }
  const currentShopId = await fetchShopeeShopId()
  if (currentShopId !== boundShopId) {
    throw new Error(
      `Sincronização bloqueada: este banco pertence à loja Shopee ${boundShopId}, ` +
        `mas a sessão aberta é da loja ${currentShopId}. Nenhum dado foi alterado.`
    )
  }
  return currentShopId
}
