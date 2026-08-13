import { app, dialog, ipcMain, shell } from 'electron'
import type {
  ActionResult,
  AppSettings,
  InternalStatus,
  OrderFilters,
  StageActionKind
} from '@shared/types'
import { getSettings, updateSettings } from './services/settings'
import {
  countAwaitingPayment,
  countByTab,
  getOrder,
  getStatusHistory,
  listOrders,
  setChildName,
  setInternalStatus,
  setNote,
  setOrderStage,
  upsertShopeeOrder
} from './services/orders'
import {
  addAction,
  createStage,
  deleteStage,
  listStages,
  nextStageId,
  removeAction,
  reorderStages,
  updateStage
} from './services/stages'
import { createOrderFolder, ensureFolderName, openOrderFolder } from './services/folders'
import { disconnect, openLoginWindow } from './services/shopee/session'
import {
  atualizarRastreios,
  buscarExtratos,
  cancelarLote,
  getConnectionStatus,
  progressoLote,
  refreshTracking,
  startSyncScheduler,
  syncAll
} from './services/shopee/sync'
import { probeShopeeApis } from './services/shopee/probe'
import { fetchOrderTotal, normalizeCard } from './services/shopee/client'
import { countDumps, dumpPath, reprocessDumps } from './services/orderDump'
import { reprocessarExtratos } from './services/recebimentos'
import { checkForUpdates, getUpdateStatus, installUpdate } from './services/updates'
import {
  countUnseenEvents,
  listEvents,
  listEventsForOrder,
  markAllEventsSeen
} from './services/events'

export function registerIpcHandlers(): void {
  // Settings
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, partial: Partial<AppSettings>) => {
    const settings = updateSettings(partial)
    startSyncScheduler() // re-aplica intervalo
    return settings
  })
  ipcMain.handle('dialog:pickDirectory', async (_e, title: string) => {
    const result = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // Shopee
  ipcMain.handle('shopee:connect', () => openLoginWindow())
  ipcMain.handle('shopee:disconnect', () => disconnect())
  ipcMain.handle('shopee:status', () => getConnectionStatus())
  ipcMain.handle('shopee:sync', () => syncAll())
  // Carga completa: percorre todas as páginas e grava o JSON cru de cada pedido.
  ipcMain.handle('shopee:syncAll', () => syncAll({ todasAsPaginas: true }))
  ipcMain.handle('shopee:orderTotal', () => fetchOrderTotal())
  // Reaplica o parsing aos JSON já salvos — sem rede.
  ipcMain.handle('shopee:reprocess', async () => {
    const r = await reprocessDumps((card) => {
      const order = normalizeCard(card)
      if (order) upsertShopeeOrder(order)
    })
    return r
  })
  ipcMain.handle('orders:reprocessarExtratos', () => reprocessarExtratos())
  ipcMain.handle('shopee:dumpInfo', async () => ({ path: dumpPath(), count: await countDumps() }))
  // Diagnóstico: descobre os endpoints reais do Seller Center (leva alguns minutos).
  ipcMain.handle('shopee:probe', async (): Promise<ActionResult> => {
    try {
      return { ok: true, path: await probeShopeeApis() }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  // Pedidos
  ipcMain.handle('orders:list', (_e, filters: OrderFilters) => listOrders(filters))
  ipcMain.handle('orders:awaitingPaymentCount', () => countAwaitingPayment())
  ipcMain.handle('orders:tabCounts', () => countByTab())
  ipcMain.handle('orders:atualizarRastreios', (_e, tab: string) => atualizarRastreios(tab))
  ipcMain.handle('orders:buscarExtratos', (_e, tab: string, refazer?: boolean) =>
    buscarExtratos(tab, refazer === true)
  )
  ipcMain.handle('lote:progresso', () => progressoLote())
  ipcMain.handle('lote:cancelar', () => cancelarLote())
  ipcMain.handle('orders:refreshTracking', (_e, orderSn: string) => refreshTracking(orderSn))
  ipcMain.handle('orders:get', (_e, orderSn: string) => getOrder(orderSn))
  ipcMain.handle('orders:setStatus', (_e, orderSn: string, status: InternalStatus) =>
    setInternalStatus(orderSn, status)
  )
  ipcMain.handle('orders:setChildName', async (_e, orderSn: string, name: string) => {
    const order = setChildName(orderSn, name)
    await ensureFolderName(orderSn)
    return order
  })
  ipcMain.handle('orders:setStage', (_e, orderSn: string, stageId: number) =>
    setOrderStage(orderSn, stageId)
  )
  ipcMain.handle('orders:setNote', (_e, orderSn: string, note: string) => setNote(orderSn, note))

  // Etapas de produção cadastráveis
  ipcMain.handle('stages:list', () => listStages())
  ipcMain.handle('stages:create', (_e, name: string, color: string | null) =>
    createStage(name, color)
  )
  ipcMain.handle('stages:update', (_e, id: number, patch: { name?: string; color?: string | null }) =>
    updateStage(id, patch)
  )
  ipcMain.handle('stages:delete', (_e, id: number) => deleteStage(id))
  ipcMain.handle('stages:reorder', (_e, orderedIds: number[]) => reorderStages(orderedIds))
  ipcMain.handle('stages:addAction', (_e, stageId: number, kind: StageActionKind, label: string) =>
    addAction(stageId, kind, label)
  )
  ipcMain.handle('stages:removeAction', (_e, actionId: number) => removeAction(actionId))
  ipcMain.handle('stages:next', (_e, currentStageId: number | null) => nextStageId(currentStageId))
  ipcMain.handle('orders:statusHistory', (_e, orderSn: string) => getStatusHistory(orderSn))
  ipcMain.handle('orders:createFolder', (_e, orderSn: string) => createOrderFolder(orderSn))
  ipcMain.handle('orders:openFolder', (_e, orderSn: string) => openOrderFolder(orderSn))
  ipcMain.handle('shell:openPath', (_e, path: string) => shell.openPath(path))

  // App / atualizações
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:status', () => getUpdateStatus())
  ipcMain.handle('updates:install', () => installUpdate())
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })

  // Eventos (rastreio, avaliação, pagamento)
  ipcMain.handle('events:list', (_e, opts: { onlyUnseen?: boolean; limit?: number }) =>
    listEvents(opts)
  )
  ipcMain.handle('events:byOrder', (_e, orderSn: string) => listEventsForOrder(orderSn))
  ipcMain.handle('events:unseenCount', () => countUnseenEvents())
  ipcMain.handle('events:markAllSeen', () => markAllEventsSeen())

}
