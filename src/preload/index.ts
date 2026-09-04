import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionResult,
  AppSettings,
  Compra,
  CustoPedido,
  Insumo,
  LinhaFabricacao,
  MovimentoEstoque,
  Produto,
  Receita,
  TipoReceita,
  InternalStatus,
  Order,
  OrderEvent,
  OrderFilters,
  OrderCounts,
  Painel,
  MetricaPainel,
  SerieMensal,
  ProgressoLote,
  ShopeeConnectionStatus,
  StageActionKind,
  StatusHistoryEntry,
  WorkflowStage,
  SyncResult,
  TrackingRefreshResult,
  UpdateStatus
} from '../shared/types'

const api = {
  database: {
    status: (): Promise<{
      configured: boolean
      url: string | null
      error?: string
      shopeeShopId?: string | null
    }> =>
      ipcRenderer.invoke('database:status'),
    configure: (input: { url: string; authToken: string }): Promise<{ ok: true; url: string }> =>
      ipcRenderer.invoke('database:configure', input)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    update: (partial: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:update', partial),
    pickDirectory: (title: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickDirectory', title)
  },
  shopee: {
    connect: (): Promise<void> => ipcRenderer.invoke('shopee:connect'),
    bind: (): Promise<string> => ipcRenderer.invoke('shopee:bind'),
    disconnect: (): Promise<void> => ipcRenderer.invoke('shopee:disconnect'),
    status: (): Promise<ShopeeConnectionStatus> => ipcRenderer.invoke('shopee:status'),
    sync: (): Promise<SyncResult> => ipcRenderer.invoke('shopee:sync'),
    probe: (): Promise<ActionResult> => ipcRenderer.invoke('shopee:probe'),
    syncAll: (): Promise<SyncResult> => ipcRenderer.invoke('shopee:syncAll'),
    orderTotal: (): Promise<number | null> => ipcRenderer.invoke('shopee:orderTotal'),
    dumpInfo: (): Promise<{ path: string; count: number }> => ipcRenderer.invoke('shopee:dumpInfo'),
    reprocess: (): Promise<{ lidos: number; aplicados: number }> =>
      ipcRenderer.invoke('shopee:reprocess'),
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
    tabCounts: (): Promise<OrderCounts> => ipcRenderer.invoke('orders:tabCounts'),
    get: (orderSn: string): Promise<Order | null> => ipcRenderer.invoke('orders:get', orderSn),
    setStatus: (orderSn: string, status: InternalStatus): Promise<Order | null> =>
      ipcRenderer.invoke('orders:setStatus', orderSn, status),
    setChildName: (orderSn: string, name: string): Promise<Order | null> =>
      ipcRenderer.invoke('orders:setChildName', orderSn, name),
    setStage: (orderSn: string, stageId: number): Promise<Order | null> =>
      ipcRenderer.invoke('orders:setStage', orderSn, stageId),
    setNote: (orderSn: string, note: string): Promise<Order | null> =>
      ipcRenderer.invoke('orders:setNote', orderSn, note),
    statusHistory: (orderSn: string): Promise<StatusHistoryEntry[]> =>
      ipcRenderer.invoke('orders:statusHistory', orderSn),
    createFolder: (orderSn: string): Promise<ActionResult> =>
      ipcRenderer.invoke('orders:createFolder', orderSn),
    openFolder: (orderSn: string): Promise<ActionResult> =>
      ipcRenderer.invoke('orders:openFolder', orderSn),
    refreshTracking: (orderSn: string): Promise<TrackingRefreshResult> =>
      ipcRenderer.invoke('orders:refreshTracking', orderSn),
    refreshIncome: (orderSn: string): Promise<ActionResult> =>
      ipcRenderer.invoke('orders:refreshIncome', orderSn),
    reprocessarExtratos: (): Promise<{ lidos: number; corrigidos: number }> =>
      ipcRenderer.invoke('orders:reprocessarExtratos')
  },
  painel: {
    resumo: (): Promise<Painel> => ipcRenderer.invoke('painel:resumo'),
    serie: (metrica: MetricaPainel, ano: number, mes: number): Promise<SerieMensal> =>
      ipcRenderer.invoke('painel:serie', metrica, ano, mes)
  },
  lote: {
    progresso: (): Promise<ProgressoLote> => ipcRenderer.invoke('lote:progresso'),
    cancelar: (): Promise<void> => ipcRenderer.invoke('lote:cancelar'),
    onProgresso: (cb: (p: ProgressoLote) => void): (() => void) => {
      const listener = (_e: unknown, p: ProgressoLote): void => cb(p)
      ipcRenderer.on('lote:progresso', listener)
      return () => ipcRenderer.removeListener('lote:progresso', listener)
    }
  },
  stages: {
    list: (): Promise<WorkflowStage[]> => ipcRenderer.invoke('stages:list'),
    create: (name: string, color: string | null): Promise<WorkflowStage[]> =>
      ipcRenderer.invoke('stages:create', name, color),
    update: (id: number, patch: { name?: string; color?: string | null }): Promise<WorkflowStage[]> =>
      ipcRenderer.invoke('stages:update', id, patch),
    remove: (id: number): Promise<WorkflowStage[]> => ipcRenderer.invoke('stages:delete', id),
    reorder: (orderedIds: number[]): Promise<WorkflowStage[]> =>
      ipcRenderer.invoke('stages:reorder', orderedIds),
    addAction: (stageId: number, kind: StageActionKind, label: string): Promise<WorkflowStage[]> =>
      ipcRenderer.invoke('stages:addAction', stageId, kind, label),
    removeAction: (actionId: number): Promise<WorkflowStage[]> =>
      ipcRenderer.invoke('stages:removeAction', actionId),
    next: (currentStageId: number | null): Promise<number | null> =>
      ipcRenderer.invoke('stages:next', currentStageId)
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
  produtos: {
    list: (): Promise<Produto[]> => ipcRenderer.invoke('produtos:list'),
    sync: (): Promise<{ ok: boolean; produtos: number; error?: string }> =>
      ipcRenderer.invoke('produtos:sync'),
    recompor: (): Promise<{ produtos: number; variacoes: number }> =>
      ipcRenderer.invoke('produtos:recompor'),
    setLinha: (itemId: string, linhaId: number | null): Promise<void> =>
      ipcRenderer.invoke('produtos:setLinha', itemId, linhaId)
  },
  insumos: {
    list: (): Promise<Insumo[]> => ipcRenderer.invoke('insumos:list'),
    criar: (input: {
      nome: string
      unidade: string
      estoqueMinimo?: number | null
      observacao?: string | null
      variantes?: string[]
    }): Promise<number> => ipcRenderer.invoke('insumos:criar', input),
    atualizar: (
      id: number,
      input: { nome?: string; unidade?: string; estoqueMinimo?: number | null; observacao?: string | null }
    ): Promise<void> => ipcRenderer.invoke('insumos:atualizar', id, input),
    remover: (id: number): Promise<void> => ipcRenderer.invoke('insumos:remover', id),
    criarVariante: (insumoId: number, nome: string): Promise<number> =>
      ipcRenderer.invoke('insumos:criarVariante', insumoId, nome),
    renomearVariante: (id: number, nome: string): Promise<void> =>
      ipcRenderer.invoke('insumos:renomearVariante', id, nome),
    removerVariante: (id: number): Promise<void> => ipcRenderer.invoke('insumos:removerVariante', id)
  },
  compras: {
    list: (limite?: number): Promise<Compra[]> => ipcRenderer.invoke('compras:list', limite),
    registrar: (input: {
      varianteId: number
      quantidade: number
      valor: number
      frete?: number
      compradoEm?: number
      fornecedor?: string | null
      observacao?: string | null
    }): Promise<number> => ipcRenderer.invoke('compras:registrar', input),
    remover: (id: number): Promise<void> => ipcRenderer.invoke('compras:remover', id)
  },
  estoque: {
    ajustar: (varianteId: number, quantidade: number, observacao?: string): Promise<void> =>
      ipcRenderer.invoke('estoque:ajustar', varianteId, quantidade, observacao),
    movimentos: (limite?: number): Promise<MovimentoEstoque[]> =>
      ipcRenderer.invoke('estoque:movimentos', limite),
    baixarDespachados: (): Promise<{ pedidos: number; movimentos: number }> =>
      ipcRenderer.invoke('estoque:baixarDespachados'),
    /** Desde quando as saídas contam — antes disso é história. */
    desde: (): Promise<number> => ipcRenderer.invoke('estoque:desde')
  },
  fabricacao: {
    linhas: (): Promise<LinhaFabricacao[]> => ipcRenderer.invoke('fabricacao:linhas'),
    componentes: (): Promise<Receita[]> => ipcRenderer.invoke('fabricacao:componentes'),
    criarLinha: (nome: string): Promise<number> => ipcRenderer.invoke('fabricacao:criarLinha', nome),
    renomearLinha: (id: number, nome: string): Promise<void> =>
      ipcRenderer.invoke('fabricacao:renomearLinha', id, nome),
    removerLinha: (id: number): Promise<void> => ipcRenderer.invoke('fabricacao:removerLinha', id),
    criarReceita: (input: {
      linhaId: number | null
      nome: string
      tipo: TipoReceita
      rende?: number
    }): Promise<number> => ipcRenderer.invoke('fabricacao:criarReceita', input),
    atualizarReceita: (id: number, input: { nome?: string; rende?: number }): Promise<void> =>
      ipcRenderer.invoke('fabricacao:atualizarReceita', id, input),
    removerReceita: (id: number): Promise<void> => ipcRenderer.invoke('fabricacao:removerReceita', id),
    adicionarItem: (input: {
      receitaId: number
      insumoId?: number | null
      receitaFilhaId?: number | null
      quantidade: number | null
    }): Promise<number> => ipcRenderer.invoke('fabricacao:adicionarItem', input),
    atualizarItem: (id: number, quantidade: number | null): Promise<void> =>
      ipcRenderer.invoke('fabricacao:atualizarItem', id, quantidade),
    removerItem: (id: number): Promise<void> => ipcRenderer.invoke('fabricacao:removerItem', id),
    consumoDoPedido: (orderSn: string): Promise<CustoPedido> =>
      ipcRenderer.invoke('fabricacao:consumoDoPedido', orderSn)
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
