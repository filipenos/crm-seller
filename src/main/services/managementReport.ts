import { getAsyncDb } from '../db'
import { buildManagementReport, reportQueries } from '@shared/managementReport'
import type { PeriodoRelatorio, RelatorioGerencial } from '@shared/types'

/** Uma leitura em lote no Turso para todas as métricas e pendências. */
export async function managementReport(period: PeriodoRelatorio): Promise<RelatorioGerencial> {
  const queries = reportQueries(period)
  let rows: unknown[][]
  try {
    rows = await getAsyncDb().queryBatch(queries)
  } catch (reason) {
    if (!isConnectionTimeout(reason)) throw reason
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      rows = await getAsyncDb().queryBatch(queries)
    } catch (retryReason) {
      if (!isConnectionTimeout(retryReason)) throw retryReason
      throw new Error('A conexão falhou ao consultar o relatório. Tente aplicar o período novamente.')
    }
  }
  return buildManagementReport(period, rows as Record<string, unknown>[][])
}

function isConnectionTimeout(reason: unknown): boolean {
  let error = reason
  while (error instanceof Error) {
    if (error.message === 'fetch failed' || error.message.includes('Connect Timeout')) return true
    error = error.cause
  }
  return false
}
