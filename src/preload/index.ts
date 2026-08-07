import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionResult,
  AppSettings,
  ChatMessage,
  Conversation,
  InternalStatus,
  Order,
  OrderEvent,
  OrderFilters,
  ShopeeConnectionStatus,
  StatusHistoryEntry,
  SyncResult,
  TrackingRefreshResult,
  UpdateStatus
} from '../shared/types'

const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    update: (partial: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:update', partial),
    pickDirectory: (title: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickDirectory', title)
  },
  shopee: {
    connect: (): Promise<void> => ipcRenderer.invoke('shopee:connect'),
    disconnect: (): Promise<void> => ipcRenderer.invoke('shopee:disconnect'),
    status: (): Promise<ShopeeConnectionStatus> => ipcRenderer.invoke('shopee:status'),
    sync: (): Promise<SyncResult> => ipcRenderer.invoke('shopee:sync'),
    probe: (): Promise<ActionResult> => ipcRenderer.invoke('shopee:probe'),
    onStatusChanged: (cb: (status: ShopeeConnectionStatus) => void): (() => void) => {
      const listener = (_e: unknown, status: ShopeeConnectionStatus): void => cb(status)
      ipcRenderer.on('shopee:status-changed', listener)
      return () => ipcRenderer.removeListener('shopee:status-changed', listener)
    }
  },
  orders: {
    list: (filters: OrderFilters): Promise<Order[]> => ipcRenderer.invoke('orders:list', filters),
    awaitingPaymentCount: (): Promise<number> =>
      ipcRenderer.invoke('orders:awaitingPaymentCount'),
    get: (orderSn: string): Promise<Order | null> => ipcRenderer.invoke('orders:get', orderSn),
    setStatus: (orderSn: string, status: InternalStatus): Promise<Order | null> =>
      ipcRenderer.invoke('orders:setStatus', orderSn, status),
    setChildName: (orderSn: string, name: string): Promise<Order | null> =>
      ipcRenderer.invoke('orders:setChildName', orderSn, name),
    setNote: (orderSn: string, note: string): Promise<Order | null> =>
      ipcRenderer.invoke('orders:setNote', orderSn, note),
    statusHistory: (orderSn: string): Promise<StatusHistoryEntry[]> =>
      ipcRenderer.invoke('orders:statusHistory', orderSn),
    createFolder: (orderSn: string): Promise<ActionResult> =>
      ipcRenderer.invoke('orders:createFolder', orderSn),
    openFolder: (orderSn: string): Promise<ActionResult> =>
      ipcRenderer.invoke('orders:openFolder', orderSn),
    generateLabel: (orderSn: string): Promise<ActionResult> =>
      ipcRenderer.invoke('orders:generateLabel', orderSn),
    refreshTracking: (orderSn: string): Promise<TrackingRefreshResult> =>
      ipcRenderer.invoke('orders:refreshTracking', orderSn)
  },
  events: {
    list: (opts: { onlyUnseen?: boolean; limit?: number }): Promise<OrderEvent[]> =>
      ipcRenderer.invoke('events:list', opts),
    byOrder: (orderSn: string): Promise<OrderEvent[]> =>
      ipcRenderer.invoke('events:byOrder', orderSn),
    unseenCount: (): Promise<number> => ipcRenderer.invoke('events:unseenCount'),
    markAllSeen: (): Promise<void> => ipcRenderer.invoke('events:markAllSeen'),
    onDataChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('data:changed', listener)
      return () => ipcRenderer.removeListener('data:changed', listener)
    }
  },
  messages: {
    conversations: (): Promise<Conversation[]> => ipcRenderer.invoke('conversations:list'),
    byConversation: (conversationId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke('messages:byConversation', conversationId),
    byOrder: (orderSn: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke('messages:byOrder', orderSn)
  },
  shell: {
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version')
  },
  updates: {
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:check'),
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:status'),
    /** Fecha e instala a versão já baixada. */
    install: (): Promise<boolean> => ipcRenderer.invoke('updates:install'),
    onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_e: unknown, status: UpdateStatus): void => cb(status)
      ipcRenderer.on('update:status', listener)
      return () => ipcRenderer.removeListener('update:status', listener)
    }
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
