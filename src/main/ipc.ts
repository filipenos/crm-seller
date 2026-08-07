import { app, dialog, ipcMain, shell } from 'electron'
import type { ActionResult, AppSettings, InternalStatus, OrderFilters } from '@shared/types'
import { getSettings, updateSettings } from './services/settings'
import {
  countAwaitingPayment,
  getOrder,
  getStatusHistory,
  listOrders,
  setChildName,
  setInternalStatus,
  setNote
} from './services/orders'
import {
  listConversations,
  listMessagesByConversation,
  listMessagesForOrder
} from './services/messages'
import { createOrderFolder, ensureFolderName, openOrderFolder } from './services/folders'
import { generateLabel } from './services/labels'
import { disconnect, openLoginWindow } from './services/shopee/session'
import {
  getConnectionStatus,
  refreshTracking,
  startSyncScheduler,
  syncAll
} from './services/shopee/sync'
import { probeShopeeApis } from './services/shopee/probe'
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
  ipcMain.handle('orders:setNote', (_e, orderSn: string, note: string) => setNote(orderSn, note))
  ipcMain.handle('orders:statusHistory', (_e, orderSn: string) => getStatusHistory(orderSn))
  ipcMain.handle('orders:createFolder', (_e, orderSn: string) => createOrderFolder(orderSn))
  ipcMain.handle('orders:openFolder', (_e, orderSn: string) => openOrderFolder(orderSn))
  ipcMain.handle('orders:generateLabel', (_e, orderSn: string) => generateLabel(orderSn))
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

  // Mensagens
  ipcMain.handle('conversations:list', () => listConversations())
  ipcMain.handle('messages:byConversation', (_e, conversationId: string) =>
    listMessagesByConversation(conversationId)
  )
  ipcMain.handle('messages:byOrder', (_e, orderSn: string) => listMessagesForOrder(orderSn))
}
