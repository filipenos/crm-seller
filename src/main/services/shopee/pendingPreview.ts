import type { PendingSyncPreview } from '@shared/types'
import { getAsyncDb } from '../../db'

/** Prévia somente do banco: nenhuma chamada à Shopee nem alteração de dados. */
export async function pendingSyncPreview(): Promise<PendingSyncPreview> {
  const [status, labels, tracking, payments] = await getAsyncDb().queryBatch([
    { sql: `SELECT COUNT(DISTINCT shopee_order_id) AS n FROM orders
      WHERE tab IN ('NAO_PAGO','A_ENVIAR','ENVIADO') AND shopee_order_id IS NOT NULL` },
    { sql: `SELECT COUNT(*) AS n FROM (SELECT 1 FROM orders
      WHERE (tab IN ('ENVIADO','CONCLUIDO') OR (tab='A_ENVIAR' AND ready_to_post=1))
        AND shopee_order_id IS NOT NULL
        AND label_generated_at IS NULL AND created_at_shopee >= ?
      ORDER BY created_at_shopee DESC LIMIT 40)`,
      parameters: [Date.now() - 45 * 86_400_000] },
    { sql: `SELECT COUNT(*) AS n FROM orders WHERE tab='ENVIADO'
      AND shopee_order_id IS NOT NULL AND delivered_at IS NULL` },
    { sql: `SELECT COUNT(*) AS n FROM orders o LEFT JOIN order_income i ON i.order_sn=o.order_sn
      WHERE o.tab='CONCLUIDO' AND o.shopee_order_id IS NOT NULL
        AND (i.order_sn IS NULL OR (i.recebido_em IS NULL AND COALESCE(i.atualizado_em,0) < ?))`,
      parameters: [Date.now() - 86_400_000] }
  ])
  const count = (rows: unknown[]): number => Number((rows[0] as { n: number } | undefined)?.n ?? 0)
  return { status: count(status), labels: count(labels), tracking: count(tracking), payments: count(payments) }
}
