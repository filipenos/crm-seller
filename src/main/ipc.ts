import { app, dialog, ipcMain, shell } from 'electron'
import type {
  ActionResult,
  AppSettings,
  InternalStatus,
  MetricaPainel,
  OrderFilters,
  StageActionKind
} from '@shared/types'
import { getSettingsAsync, updateSettingsAsync } from './services/settings'
import { closeDb, prepareTursoDatabaseAsync } from './db'
import { publicTursoConfig, writeTursoConfig } from './db/config'
import { provisionTursoDatabase } from './db/tursoPlatform'
import {
  assertCurrentShopeeAccount,
  bindCurrentShopeeAccountAsync,
  getBoundShopeeShopIdAsync
} from './services/shopee/accountBinding'
import {
  countAwaitingPaymentAsync,
  countByTabAsync,
  getOrderAsync,
  getStatusHistoryAsync,
  listOrdersAsync,
  setChildNameAsync,
  setInternalStatusAsync,
  setNoteAsync,
  setOrderStageAsync,
  upsertShopeeOrderAsync
} from './services/orders'
import {
  addActionAsync,
  createStageAsync,
  deleteStageAsync,
  listStagesAsync,
  nextStageIdAsync,
  removeActionAsync,
  reorderStagesAsync,
  updateStageAsync
} from './services/stages'
import { createOrderFolder, ensureFolderName, openOrderFolder } from './services/folders'
import { disconnect, openLoginWindow, openLoginWindowAndWait } from './services/shopee/session'
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
import { reprocessarExtratosAsync } from './services/recebimentos'
import { montarPainel, serieMensal } from './services/dashboard'
import { checkForUpdates, getUpdateStatus, installUpdate } from './services/updates'
import {
  definirLinhaDoProdutoAsync,
  listarProdutosAsync,
  recomporCatalogoDosPedidosAsync
} from './services/produtos'
import {
  ajustarEstoqueAsync,
  atualizarInsumoAsync,
  criarInsumoAsync,
  criarVarianteAsync,
  listarComprasAsync,
  listarInsumosAsync,
  listarMovimentosAsync,
  registrarCompraAsync,
  removerCompraAsync,
  removerInsumoAsync,
  removerVarianteAsync,
  renomearVarianteAsync
} from './services/insumos'
import {
  adicionarItemAsync,
  atualizarItemAsync,
  atualizarReceitaAsync,
  baixarEstoqueDosDespachadosAsync,
  consumoDoPedidoAsync,
  criarLinhaAsync,
  estoqueDesdeAsync,
  criarReceitaAsync,
  listarComponentesAsync,
  listarLinhasAsync,
  removerItemAsync,
  removerLinhaAsync,
  removerReceitaAsync,
  renomearLinhaAsync
} from './services/receitas'
import {
  countUnseenEventsAsync,
  listEventsAsync,
  listEventsForOrderAsync,
  markAllEventsSeenAsync
} from './services/events'
import {
  adjustCompositionStock,
  compositionSummary,
  createCompositionItem,
  createCompositionKitSize,
  createCompositionProductionLot,
  createCompositionVariant,
  deleteCompositionItem,
  deleteCompositionKitSize,
  deleteCompositionPurchase,
  deleteCompositionVariant,
  previewCompositionProduction,
  recordCompositionPurchase,
  removeCompositionPart,
  setCompositionPart,
  updateCompositionItem,
  updateCompositionKitSize,
  updateCompositionPurchase,
  updateCompositionVariant
} from './services/composition'

export function registerIpcHandlers(onDatabaseReady: (reset?: boolean) => Promise<void>): void {
  ipcMain.handle('database:status', async () => {
    const status = publicTursoConfig()
    if (!status.configured) return status
    try {
      await onDatabaseReady()
      return { ...status, shopeeShopId: await getBoundShopeeShopIdAsync() }
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
    async (event, input: { platformToken: string }): Promise<{ ok: true; url: string }> => {
      const progress = (message: string): void => event.sender.send('database:progress', message)
      const credentials = await provisionTursoDatabase(input.platformToken, progress)
      await prepareTursoDatabaseAsync(credentials, progress)
      closeDb()
      writeTursoConfig(credentials)
      progress('Banco conectado e pronto.')
      await onDatabaseReady(true)
      return { ok: true, url: credentials.url }
    }
  )

  // Settings
  ipcMain.handle('settings:get', () => getSettingsAsync())
  ipcMain.handle('settings:update', async (_e, partial: Partial<AppSettings>) => {
    const settings = await updateSettingsAsync(partial)
    startSyncScheduler(settings) // re-aplica intervalo sem nova consulta bloqueante
    return settings
  })
  ipcMain.handle('dialog:pickDirectory', async (_e, title: string) => {
    const result = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // Shopee
  ipcMain.handle('shopee:connect', () => openLoginWindow())
  ipcMain.handle('shopee:setup', async () => {
    await openLoginWindowAndWait()
    return bindCurrentShopeeAccountAsync()
  })
  ipcMain.handle('shopee:bind', () => bindCurrentShopeeAccountAsync())
  ipcMain.handle('shopee:disconnect', () => disconnect())
  ipcMain.handle('shopee:status', () => getConnectionStatus())
  ipcMain.handle('shopee:sync', () => syncAll())
  // Carga completa: percorre todas as páginas e grava o JSON cru de cada pedido.
  ipcMain.handle('shopee:syncAll', () => syncAll({ todasAsPaginas: true }))
  ipcMain.handle('shopee:orderTotal', () => fetchOrderTotal())
  // Reaplica o parsing aos JSON já salvos — sem rede.
  ipcMain.handle('shopee:reprocess', async () => {
    await assertCurrentShopeeAccount()
    const r = await reprocessDumps(async (card) => {
      const order = normalizeCard(card)
      if (order) await upsertShopeeOrderAsync(order)
    })
    return r
  })
  ipcMain.handle('orders:reprocessarExtratos', () => reprocessarExtratosAsync())
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
  ipcMain.handle('orders:list', (_e, filters: OrderFilters) => listOrdersAsync(filters))
  ipcMain.handle('orders:awaitingPaymentCount', () => countAwaitingPaymentAsync())
  ipcMain.handle('orders:tabCounts', () => countByTabAsync())
  ipcMain.handle('painel:resumo', () => montarPainel())
  ipcMain.handle('painel:serie', (_e, metrica: MetricaPainel, ano: number, mes: number) =>
    serieMensal(metrica, ano, mes)
  )
  ipcMain.handle('orders:refreshIncome', (_e, orderSn: string) => refreshIncome(orderSn))
  ipcMain.handle('lote:progresso', () => progressoLote())
  ipcMain.handle('lote:cancelar', () => cancelarLote())
  ipcMain.handle('orders:refreshTracking', (_e, orderSn: string) => refreshTracking(orderSn))
  ipcMain.handle('orders:get', (_e, orderSn: string) => getOrderAsync(orderSn))
  ipcMain.handle('orders:setStatus', (_e, orderSn: string, status: InternalStatus) =>
    setInternalStatusAsync(orderSn, status)
  )
  ipcMain.handle('orders:setChildName', async (_e, orderSn: string, name: string) => {
    const order = await setChildNameAsync(orderSn, name)
    await ensureFolderName(orderSn)
    return order
  })
  ipcMain.handle('orders:setStage', (_e, orderSn: string, stageId: number) =>
    setOrderStageAsync(orderSn, stageId)
  )
  ipcMain.handle('orders:setNote', (_e, orderSn: string, note: string) => setNoteAsync(orderSn, note))

  // Etapas de produção cadastráveis
  ipcMain.handle('stages:list', () => listStagesAsync())
  ipcMain.handle('stages:create', (_e, name: string, color: string | null) =>
    createStageAsync(name, color)
  )
  ipcMain.handle('stages:update', (_e, id: number, patch: { name?: string; color?: string | null }) =>
    updateStageAsync(id, patch)
  )
  ipcMain.handle('stages:delete', (_e, id: number) => deleteStageAsync(id))
  ipcMain.handle('stages:reorder', (_e, orderedIds: number[]) => reorderStagesAsync(orderedIds))
  ipcMain.handle('stages:addAction', (_e, stageId: number, kind: StageActionKind, label: string) =>
    addActionAsync(stageId, kind, label)
  )
  ipcMain.handle('stages:removeAction', (_e, actionId: number) => removeActionAsync(actionId))
  ipcMain.handle('stages:next', (_e, currentStageId: number | null) => nextStageIdAsync(currentStageId))
  ipcMain.handle('orders:statusHistory', (_e, orderSn: string) => getStatusHistoryAsync(orderSn))
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
    listEventsAsync(opts)
  )
  ipcMain.handle('events:byOrder', (_e, orderSn: string) => listEventsForOrderAsync(orderSn))
  ipcMain.handle('events:unseenCount', () => countUnseenEventsAsync())
  ipcMain.handle('events:markAllSeen', () => markAllEventsSeenAsync())

  // Produtos
  ipcMain.handle('produtos:list', () => listarProdutosAsync())
  ipcMain.handle('produtos:sync', () => sincronizarProdutos())
  // Reconstrói o catálogo a partir dos pedidos — sem rede.
  ipcMain.handle('produtos:recompor', () => recomporCatalogoDosPedidosAsync())
  ipcMain.handle('produtos:setLinha', (_e, itemId: string, linhaId: number | null) =>
    definirLinhaDoProdutoAsync(itemId, linhaId)
  )

  // Insumos, compras e estoque
  ipcMain.handle('insumos:list', () => listarInsumosAsync())
  ipcMain.handle('insumos:criar', (_e, input: Parameters<typeof criarInsumoAsync>[0]) => criarInsumoAsync(input))
  ipcMain.handle('insumos:atualizar', (_e, id: number, input: Parameters<typeof atualizarInsumoAsync>[1]) =>
    atualizarInsumoAsync(id, input)
  )
  ipcMain.handle('insumos:remover', (_e, id: number) => removerInsumoAsync(id))
  ipcMain.handle('insumos:criarVariante', (_e, insumoId: number, nome: string) =>
    criarVarianteAsync(insumoId, nome)
  )
  ipcMain.handle('insumos:renomearVariante', (_e, id: number, nome: string) => renomearVarianteAsync(id, nome))
  ipcMain.handle('insumos:removerVariante', (_e, id: number) => removerVarianteAsync(id))
  ipcMain.handle('compras:list', (_e, limite?: number) => listarComprasAsync(limite))
  ipcMain.handle('compras:registrar', (_e, input: Parameters<typeof registrarCompraAsync>[0]) =>
    registrarCompraAsync(input)
  )
  ipcMain.handle('compras:remover', (_e, id: number) => removerCompraAsync(id))
  ipcMain.handle('estoque:ajustar', (_e, varianteId: number, quantidade: number, obs?: string) =>
    ajustarEstoqueAsync(varianteId, quantidade, obs)
  )
  ipcMain.handle('estoque:movimentos', (_e, limite?: number) => listarMovimentosAsync(limite))
  ipcMain.handle('estoque:baixarDespachados', () => baixarEstoqueDosDespachadosAsync())
  ipcMain.handle('estoque:desde', () => estoqueDesdeAsync())

  // Receitas e linhas de fabricação
  ipcMain.handle('fabricacao:linhas', () => listarLinhasAsync())
  ipcMain.handle('fabricacao:componentes', () => listarComponentesAsync())
  ipcMain.handle('fabricacao:criarLinha', (_e, nome: string) => criarLinhaAsync(nome))
  ipcMain.handle('fabricacao:renomearLinha', (_e, id: number, nome: string) => renomearLinhaAsync(id, nome))
  ipcMain.handle('fabricacao:removerLinha', (_e, id: number) => removerLinhaAsync(id))
  ipcMain.handle('fabricacao:criarReceita', (_e, input: Parameters<typeof criarReceitaAsync>[0]) =>
    criarReceitaAsync(input)
  )
  ipcMain.handle('fabricacao:atualizarReceita', (_e, id: number, input: { nome?: string; rende?: number }) =>
    atualizarReceitaAsync(id, input)
  )
  ipcMain.handle('fabricacao:removerReceita', (_e, id: number) => removerReceitaAsync(id))
  ipcMain.handle('fabricacao:adicionarItem', (_e, input: Parameters<typeof adicionarItemAsync>[0]) =>
    adicionarItemAsync(input)
  )
  ipcMain.handle('fabricacao:atualizarItem', (_e, id: number, quantidade: number | null) =>
    atualizarItemAsync(id, quantidade)
  )
  ipcMain.handle('fabricacao:removerItem', (_e, id: number) => removerItemAsync(id))
  ipcMain.handle('fabricacao:consumoDoPedido', (_e, orderSn: string) => consumoDoPedidoAsync(orderSn))

  // Composição independente de pedidos e da Shopee.
  ipcMain.handle('composicao:resumo', () => compositionSummary())
  ipcMain.handle('composicao:criarItem', (_e, input: Parameters<typeof createCompositionItem>[0]) =>
    createCompositionItem(input)
  )
  ipcMain.handle(
    'composicao:atualizarItem',
    (_e, id: number, input: Parameters<typeof updateCompositionItem>[1]) =>
      updateCompositionItem(id, input)
  )
  ipcMain.handle('composicao:removerItem', (_e, id: number) => deleteCompositionItem(id))
  ipcMain.handle('composicao:criarVariante', (_e, itemId: number, nome: string) =>
    createCompositionVariant(itemId, nome)
  )
  ipcMain.handle('composicao:atualizarVariante', (_e, id: number, nome: string) =>
    updateCompositionVariant(id, nome)
  )
  ipcMain.handle('composicao:removerVariante', (_e, id: number) => deleteCompositionVariant(id))
  ipcMain.handle('composicao:criarTamanhoKit', (_e, input: Parameters<typeof createCompositionKitSize>[0]) =>
    createCompositionKitSize(input)
  )
  ipcMain.handle('composicao:atualizarTamanhoKit', (_e, id: number, input: Parameters<typeof updateCompositionKitSize>[1]) =>
    updateCompositionKitSize(id, input)
  )
  ipcMain.handle('composicao:removerTamanhoKit', (_e, id: number) => deleteCompositionKitSize(id))
  ipcMain.handle('composicao:definirParte', (_e, input: Parameters<typeof setCompositionPart>[0]) =>
    setCompositionPart(input)
  )
  ipcMain.handle('composicao:removerParte', (_e, id: number) => removeCompositionPart(id))
  ipcMain.handle('composicao:registrarCompra', (_e, input: Parameters<typeof recordCompositionPurchase>[0]) =>
    recordCompositionPurchase(input)
  )
  ipcMain.handle('composicao:removerCompra', (_e, id: number) => deleteCompositionPurchase(id))
  ipcMain.handle('composicao:atualizarCompra', (_e, id: number, input: Parameters<typeof updateCompositionPurchase>[1]) =>
    updateCompositionPurchase(id, input)
  )
  ipcMain.handle('composicao:ajustarEstoque', (_e, input: Parameters<typeof adjustCompositionStock>[0]) =>
    adjustCompositionStock(input)
  )
  ipcMain.handle('composicao:preverProducao', (_e, itemId: number, quantidade: number) =>
    previewCompositionProduction(itemId, quantidade)
  )
  ipcMain.handle('composicao:registrarLote', (_e, input: Parameters<typeof createCompositionProductionLot>[0]) =>
    createCompositionProductionLot(input)
  )

}
