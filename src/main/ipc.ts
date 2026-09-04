import { app, dialog, ipcMain, shell } from 'electron'
import type {
  ActionResult,
  AppSettings,
  InternalStatus,
  MetricaPainel,
  OrderFilters,
  StageActionKind
} from '@shared/types'
import { getSettings, updateSettings } from './services/settings'
import { closeDb, testTursoConnection } from './db'
import { publicTursoConfig, writeTursoConfig } from './db/config'
import {
  assertCurrentShopeeAccount,
  bindCurrentShopeeAccount,
  getBoundShopeeShopId
} from './services/shopee/accountBinding'
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
  cancelarLote,
  getConnectionStatus,
  progressoLote,
  refreshIncome,
  refreshTracking,
  sincronizarProdutos,
  startSyncScheduler,
  syncAll
} from './services/shopee/sync'
import { probeShopeeApis } from './services/shopee/probe'
import { fetchOrderTotal, normalizeCard } from './services/shopee/client'
import { countDumps, dumpPath, reprocessDumps } from './services/orderDump'
import { reprocessarExtratos } from './services/recebimentos'
import { montarPainel, serieMensal } from './services/dashboard'
import { checkForUpdates, getUpdateStatus, installUpdate } from './services/updates'
import {
  definirLinhaDoProduto,
  listarProdutos,
  recomporCatalogoDosPedidos
} from './services/produtos'
import {
  ajustarEstoque,
  atualizarInsumo,
  criarInsumo,
  criarVariante,
  listarCompras,
  listarInsumos,
  listarMovimentos,
  registrarCompra,
  removerCompra,
  removerInsumo,
  removerVariante,
  renomearVariante
} from './services/insumos'
import {
  adicionarItem,
  atualizarItem,
  atualizarReceita,
  baixarEstoqueDosDespachados,
  consumoDoPedido,
  criarLinha,
  estoqueDesde,
  criarReceita,
  listarComponentes,
  listarLinhas,
  removerItem,
  removerLinha,
  removerReceita,
  renomearLinha
} from './services/receitas'
import {
  countUnseenEvents,
  listEvents,
  listEventsForOrder,
  markAllEventsSeen
} from './services/events'

export function registerIpcHandlers(onDatabaseReady: () => void): void {
  ipcMain.handle('database:status', () => {
    const status = publicTursoConfig()
    if (!status.configured) return status
    try {
      onDatabaseReady()
      return { ...status, shopeeShopId: getBoundShopeeShopId() }
    } catch (reason) {
      return {
        configured: false,
        url: status.url,
        error: String(reason instanceof Error ? reason.message : reason)
      }
    }
  })
  ipcMain.handle(
    'database:configure',
    (_e, input: { url: string; authToken: string }): { ok: true; url: string } => {
      testTursoConnection(input)
      closeDb()
      writeTursoConfig(input)
      onDatabaseReady()
      return { ok: true, url: input.url.trim().replace(/\/$/, '') }
    }
  )

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
  ipcMain.handle('shopee:bind', () => bindCurrentShopeeAccount())
  ipcMain.handle('shopee:disconnect', () => disconnect())
  ipcMain.handle('shopee:status', () => getConnectionStatus())
  ipcMain.handle('shopee:sync', () => syncAll())
  // Carga completa: percorre todas as páginas e grava o JSON cru de cada pedido.
  ipcMain.handle('shopee:syncAll', () => syncAll({ todasAsPaginas: true }))
  ipcMain.handle('shopee:orderTotal', () => fetchOrderTotal())
  // Reaplica o parsing aos JSON já salvos — sem rede.
  ipcMain.handle('shopee:reprocess', async () => {
    await assertCurrentShopeeAccount()
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
  ipcMain.handle('painel:resumo', () => montarPainel())
  ipcMain.handle('painel:serie', (_e, metrica: MetricaPainel, ano: number, mes: number) =>
    serieMensal(metrica, ano, mes)
  )
  ipcMain.handle('orders:refreshIncome', (_e, orderSn: string) => refreshIncome(orderSn))
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

  // Produtos
  ipcMain.handle('produtos:list', () => listarProdutos())
  ipcMain.handle('produtos:sync', () => sincronizarProdutos())
  // Reconstrói o catálogo a partir dos pedidos — sem rede.
  ipcMain.handle('produtos:recompor', () => recomporCatalogoDosPedidos())
  ipcMain.handle('produtos:setLinha', (_e, itemId: string, linhaId: number | null) =>
    definirLinhaDoProduto(itemId, linhaId)
  )

  // Insumos, compras e estoque
  ipcMain.handle('insumos:list', () => listarInsumos())
  ipcMain.handle('insumos:criar', (_e, input: Parameters<typeof criarInsumo>[0]) => criarInsumo(input))
  ipcMain.handle('insumos:atualizar', (_e, id: number, input: Parameters<typeof atualizarInsumo>[1]) =>
    atualizarInsumo(id, input)
  )
  ipcMain.handle('insumos:remover', (_e, id: number) => removerInsumo(id))
  ipcMain.handle('insumos:criarVariante', (_e, insumoId: number, nome: string) =>
    criarVariante(insumoId, nome)
  )
  ipcMain.handle('insumos:renomearVariante', (_e, id: number, nome: string) => renomearVariante(id, nome))
  ipcMain.handle('insumos:removerVariante', (_e, id: number) => removerVariante(id))
  ipcMain.handle('compras:list', (_e, limite?: number) => listarCompras(limite))
  ipcMain.handle('compras:registrar', (_e, input: Parameters<typeof registrarCompra>[0]) =>
    registrarCompra(input)
  )
  ipcMain.handle('compras:remover', (_e, id: number) => removerCompra(id))
  ipcMain.handle('estoque:ajustar', (_e, varianteId: number, quantidade: number, obs?: string) =>
    ajustarEstoque(varianteId, quantidade, obs)
  )
  ipcMain.handle('estoque:movimentos', (_e, limite?: number) => listarMovimentos(limite))
  ipcMain.handle('estoque:baixarDespachados', () => baixarEstoqueDosDespachados())
  ipcMain.handle('estoque:desde', () => estoqueDesde())

  // Receitas e linhas de fabricação
  ipcMain.handle('fabricacao:linhas', () => listarLinhas())
  ipcMain.handle('fabricacao:componentes', () => listarComponentes())
  ipcMain.handle('fabricacao:criarLinha', (_e, nome: string) => criarLinha(nome))
  ipcMain.handle('fabricacao:renomearLinha', (_e, id: number, nome: string) => renomearLinha(id, nome))
  ipcMain.handle('fabricacao:removerLinha', (_e, id: number) => removerLinha(id))
  ipcMain.handle('fabricacao:criarReceita', (_e, input: Parameters<typeof criarReceita>[0]) =>
    criarReceita(input)
  )
  ipcMain.handle('fabricacao:atualizarReceita', (_e, id: number, input: { nome?: string; rende?: number }) =>
    atualizarReceita(id, input)
  )
  ipcMain.handle('fabricacao:removerReceita', (_e, id: number) => removerReceita(id))
  ipcMain.handle('fabricacao:adicionarItem', (_e, input: Parameters<typeof adicionarItem>[0]) =>
    adicionarItem(input)
  )
  ipcMain.handle('fabricacao:atualizarItem', (_e, id: number, quantidade: number | null) =>
    atualizarItem(id, quantidade)
  )
  ipcMain.handle('fabricacao:removerItem', (_e, id: number) => removerItem(id))
  ipcMain.handle('fabricacao:consumoDoPedido', (_e, orderSn: string) => consumoDoPedido(orderSn))

}
