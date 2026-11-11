import { app } from 'electron'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import * as z from 'zod/v4'
import { getSettingsAsync } from './settings'
import { montarPainel } from './dashboard'
import { managementReport } from './managementReport'
import { workAgenda } from './workAgenda'
import { getOrderAsync, listOrdersAsync, setChildNameAsync, setNoteAsync, setInternalStatusAsync } from './orders'
import { listarProdutosAsync } from './produtos'
import { compositionSummary, createCompositionItem, updateCompositionItem, deleteCompositionItem, setCompositionPart, removeCompositionPart, adjustCompositionStock, createCompositionVariant, updateCompositionVariant, deleteCompositionVariant, createCompositionKitSize, updateCompositionKitSize, deleteCompositionKitSize, recordCompositionPurchase, updateCompositionPurchase, deleteCompositionPurchase, previewCompositionProduction, createCompositionProductionLot } from './composition'
import { listarInsumosAsync, listarComprasAsync, listarMovimentosAsync, ajustarEstoqueAsync, criarInsumoAsync, atualizarInsumoAsync, criarVarianteAsync, renomearVarianteAsync, registrarCompraAsync } from './insumos'
import { listProductionFlows, listOrderProduction, actOnProductionItem } from './production'
import { getConnectionStatus, progressoLote, syncAll, refreshIncome, refreshTracking } from './shopee/sync'
import { pendingSyncPreview } from './shopee/pendingPreview'
import { INTERNAL_STATUSES, UNIDADES, type Order, type ProductionActionKind } from '@shared/types'
import { mcpAccessStatus } from './mcpAccess'

const LOCAL_PORT = 38765
const LAN_PORT = 38766
let localServer: Server | null = null
let lanServer: Server | null = null
let syncJob: { state: 'running' | 'done' | 'error'; startedAt: number; finishedAt?: number; error?: string } | null = null

function result(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value === undefined ? { ok: true } : value) }] }
}

function publicOrder(order: Order | null): Omit<Order, 'folderPath'> | null {
  if (!order) return null
  const { folderPath: _folderPath, ...safe } = order
  return safe
}

async function run(ready: () => Promise<void>, task: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    await ready()
    return result(await task())
  } catch (error) {
    // As mensagens de erro podem conter dados de conexão; não as devolvemos ao cliente MCP.
    return { isError: true, content: [{ type: 'text', text: error instanceof Error && /^(Escolha|Pedido|Item|Quantidade|Nome)/.test(error.message)
      ? error.message : 'Operação não concluída. Verifique o aplicativo.' }] }
  }
}

function createTools(ready: () => Promise<void>): McpServer {
  const mcp = new McpServer({ name: 'crm-seller', version: app.getVersion() }, { instructions: 'Use estas ferramentas para consultar e operar o CRM Seller. A configuração do banco, contas e credenciais permanece no aplicativo. Não invente resultados de sincronização: consulte o progresso após iniciar.' })
  mcp.registerTool('visao_do_dia', { description: 'Resumo de vendas, valores e trabalho dos próximos dias.', inputSchema: z.object({ dias: z.number().int().min(1).max(10).default(7) }), annotations: { readOnlyHint: true } }, async ({ dias }) => run(ready, async () => { const [painel, agenda] = await Promise.all([montarPainel(), workAgenda(dias)]); return { painel, agenda } }))
  mcp.registerTool('agenda_trabalho', { description: 'Pedidos, laços e caixas a produzir por prazo interno de postagem.', inputSchema: z.object({ dias: z.number().int().min(1).max(10).default(7) }), annotations: { readOnlyHint: true } }, async ({ dias }) => run(ready, () => workAgenda(dias)))
  mcp.registerTool('relatorio_gerencial', { description: 'Métricas de vendas, despachos, recebimentos, pendências e anúncios em um período.', inputSchema: z.object({ inicio: z.iso.date(), fim: z.iso.date() }), annotations: { readOnlyHint: true } }, async ({ inicio, fim }) => run(ready, () => managementReport({ inicio, fim })))
  mcp.registerTool('listar_pedidos', { description: 'Lista até 100 pedidos; filtre por termo, aba ou usuário.', inputSchema: z.object({ busca: z.string().max(120).optional(), aba: z.enum(['A_ENVIAR', 'ENVIADO', 'CONCLUIDO', 'CANCELADO', 'TODOS']).optional(), usuario: z.string().max(120).optional(), limite: z.number().int().min(1).max(100).default(30) }), annotations: { readOnlyHint: true } }, async ({ busca, aba, usuario, limite }) => run(ready, async () => (await listOrdersAsync({ search: busca, tab: aba, buyerUsername: usuario, limit: limite })).map(publicOrder)))
  mcp.registerTool('detalhar_pedido', { description: 'Mostra os dados de um pedido pelo ID da Shopee.', inputSchema: z.object({ pedido: z.string().min(1).max(80) }), annotations: { readOnlyHint: true } }, async ({ pedido }) => run(ready, async () => publicOrder(await getOrderAsync(pedido))))
  mcp.registerTool('definir_nome_crianca', { description: 'Salva o nome da criança em um pedido.', inputSchema: z.object({ pedido: z.string().min(1).max(80), nome: z.string().min(1).max(150) }) }, async ({ pedido, nome }) => run(ready, async () => publicOrder(await setChildNameAsync(pedido, nome))))
  mcp.registerTool('anotar_pedido', { description: 'Salva uma observação no pedido.', inputSchema: z.object({ pedido: z.string().min(1).max(80), observacao: z.string().max(4000) }) }, async ({ pedido, observacao }) => run(ready, async () => publicOrder(await setNoteAsync(pedido, observacao))))
  mcp.registerTool('definir_status_pedido', { description: 'Altera o status interno do pedido.', inputSchema: z.object({ pedido: z.string().min(1).max(80), status: z.enum(INTERNAL_STATUSES) }) }, async ({ pedido, status }) => run(ready, async () => publicOrder(await setInternalStatusAsync(pedido, status))))
  mcp.registerTool('atualizar_rastreio_pedido', { description: 'Consulta Shopee e atualiza o rastreio de um pedido.', inputSchema: z.object({ pedido: z.string().min(1).max(80) }) }, async ({ pedido }) => run(ready, () => refreshTracking(pedido)))
  mcp.registerTool('atualizar_pagamento_pedido', { description: 'Consulta Shopee e atualiza o recebimento de um pedido.', inputSchema: z.object({ pedido: z.string().min(1).max(80) }) }, async ({ pedido }) => run(ready, () => refreshIncome(pedido)))
  mcp.registerTool('produtos', { description: 'Catálogo de produtos e variações.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => run(ready, () => listarProdutosAsync()))
  mcp.registerTool('composicao', { description: 'Itens, estruturas, custos, compras e estoque da composição.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => run(ready, () => compositionSummary()))
  mcp.registerTool('criar_item_composicao', { description: 'Cadastra um item na composição.', inputSchema: z.object({ nome: z.string().min(1).max(150), tipo: z.enum(['MATERIA_PRIMA', 'COMPONENTE', 'CAIXA', 'KIT']), unidade: z.enum(UNIDADES) }) }, async ({ nome, tipo, unidade }) => run(ready, () => createCompositionItem({ nome, tipo, unidade })))
  mcp.registerTool('atualizar_item_composicao', { description: 'Altera nome ou custo de referência de um item da composição.', inputSchema: z.object({ id: z.number().int().positive(), nome: z.string().min(1).max(150).optional(), custoReferencia: z.number().nonnegative().nullable().optional() }) }, async ({ id, nome, custoReferencia }) => run(ready, () => updateCompositionItem(id, { nome, custoReferencia })))
  mcp.registerTool('definir_parte_composicao', { description: 'Define quanto de um item filho entra em uma composição.', inputSchema: z.object({ paiId: z.number().int().positive(), filhoId: z.number().int().positive(), quantidade: z.number().positive() }) }, async ({ paiId, filhoId, quantidade }) => run(ready, () => setCompositionPart({ itemId: paiId, componenteId: filhoId, quantidade })))
  mcp.registerTool('remover_parte_composicao', { description: 'Remove uma parte da estrutura pelo ID da relação.', inputSchema: z.object({ id: z.number().int().positive() }) }, async ({ id }) => run(ready, () => removeCompositionPart(id)))
  mcp.registerTool('remover_item_composicao', { description: 'Apaga item da composição quando não estiver em uso.', inputSchema: z.object({ id: z.number().int().positive() }) }, async ({ id }) => run(ready, () => deleteCompositionItem(id)))
  mcp.registerTool('criar_variante_composicao', { description: 'Cria variante de um item da composição.', inputSchema: z.object({ itemId: z.number().int().positive(), nome: z.string().min(1).max(120) }) }, async ({ itemId, nome }) => run(ready, () => createCompositionVariant(itemId, nome)))
  mcp.registerTool('renomear_variante_composicao', { description: 'Renomeia variante de um item da composição.', inputSchema: z.object({ id: z.number().int().positive(), nome: z.string().min(1).max(120) }) }, async ({ id, nome }) => run(ready, () => updateCompositionVariant(id, nome)))
  mcp.registerTool('remover_variante_composicao', { description: 'Apaga variante da composição quando não estiver em uso.', inputSchema: z.object({ id: z.number().int().positive() }) }, async ({ id }) => run(ready, () => deleteCompositionVariant(id)))
  mcp.registerTool('criar_tamanho_kit', { description: 'Cadastra tamanho de kit da composição.', inputSchema: z.object({ itemId: z.number().int().positive(), totalCaixas: z.number().positive(), multiplicador: z.number().positive() }) }, async (input) => run(ready, () => createCompositionKitSize(input)))
  mcp.registerTool('atualizar_tamanho_kit', { description: 'Atualiza tamanho de kit da composição.', inputSchema: z.object({ id: z.number().int().positive(), totalCaixas: z.number().positive(), multiplicador: z.number().positive() }) }, async ({ id, totalCaixas, multiplicador }) => run(ready, () => updateCompositionKitSize(id, { totalCaixas, multiplicador })))
  mcp.registerTool('remover_tamanho_kit', { description: 'Remove tamanho de kit sem lote vinculado.', inputSchema: z.object({ id: z.number().int().positive() }) }, async ({ id }) => run(ready, () => deleteCompositionKitSize(id)))
  mcp.registerTool('registrar_compra_composicao', { description: 'Registra compra de material e entrada em estoque da composição.', inputSchema: z.object({ itemId: z.number().int().positive(), varianteId: z.number().int().positive().nullable().default(null), quantidade: z.number().positive(), valor: z.number().nonnegative(), frete: z.number().nonnegative().default(0), fornecedor: z.string().max(150).optional() }) }, async ({ itemId, varianteId, quantidade, valor, frete, fornecedor }) => run(ready, () => recordCompositionPurchase({ itemId, variantId: varianteId, quantidade, valor, frete, fornecedor })))
  mcp.registerTool('atualizar_compra_composicao', { description: 'Corrige uma compra já registrada na composição.', inputSchema: z.object({ id: z.number().int().positive(), itemId: z.number().int().positive(), varianteId: z.number().int().positive().nullable().default(null), quantidade: z.number().positive(), valor: z.number().nonnegative(), frete: z.number().nonnegative().default(0), fornecedor: z.string().max(150).optional() }) }, async ({ id, itemId, varianteId, quantidade, valor, frete, fornecedor }) => run(ready, () => updateCompositionPurchase(id, { itemId, variantId: varianteId, quantidade, valor, frete, fornecedor })))
  mcp.registerTool('remover_compra_composicao', { description: 'Remove compra e respectiva entrada em estoque.', inputSchema: z.object({ id: z.number().int().positive() }) }, async ({ id }) => run(ready, () => deleteCompositionPurchase(id)))
  mcp.registerTool('prever_producao', { description: 'Mostra consumo previsto para produzir item da composição.', inputSchema: z.object({ itemId: z.number().int().positive(), quantidade: z.number().positive() }), annotations: { readOnlyHint: true } }, async ({ itemId, quantidade }) => run(ready, () => previewCompositionProduction(itemId, quantidade)))
  mcp.registerTool('registrar_lote_producao', { description: 'Registra lote de produção e consumo efetivo dos materiais.', inputSchema: z.object({ itemId: z.number().int().positive(), varianteId: z.number().int().positive().nullable().optional(), tamanhoKitId: z.number().int().positive().nullable().optional(), quantidade: z.number().positive(), observacao: z.string().max(500).optional(), consumos: z.array(z.object({ itemId: z.number().int().positive(), varianteId: z.number().int().positive().nullable(), quantidade: z.number().positive() })).min(1) }) }, async ({ itemId, varianteId, tamanhoKitId, quantidade, observacao, consumos }) => run(ready, () => createCompositionProductionLot({ itemId, variantId: varianteId, kitSizeId: tamanhoKitId, quantidade, observacao, consumos: consumos.map((item) => ({ itemId: item.itemId, variantId: item.varianteId, quantidade: item.quantidade })) })))
  mcp.registerTool('ajustar_estoque_composicao', { description: 'Registra ajuste de estoque de item da composição.', inputSchema: z.object({ itemId: z.number().int().positive(), varianteId: z.number().int().positive().nullable().default(null), quantidade: z.number().finite(), observacao: z.string().max(500).optional() }) }, async ({ itemId, varianteId, quantidade, observacao }) => run(ready, () => adjustCompositionStock({ itemId, variantId: varianteId, quantidade, observacao })))
  mcp.registerTool('insumos', { description: 'Insumos, variantes, saldos e custo médio.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => run(ready, () => listarInsumosAsync()))
  mcp.registerTool('criar_insumo', { description: 'Cadastra um insumo comprado.', inputSchema: z.object({ nome: z.string().min(1).max(150), unidade: z.enum(UNIDADES), estoqueMinimo: z.number().nonnegative().nullable().optional(), observacao: z.string().max(500).optional() }) }, async (input) => run(ready, () => criarInsumoAsync(input)))
  mcp.registerTool('atualizar_insumo', { description: 'Atualiza dados básicos de um insumo.', inputSchema: z.object({ id: z.number().int().positive(), nome: z.string().min(1).max(150).optional(), estoqueMinimo: z.number().nonnegative().nullable().optional(), observacao: z.string().max(500).optional() }) }, async ({ id, ...input }) => run(ready, () => atualizarInsumoAsync(id, input)))
  mcp.registerTool('criar_variante_insumo', { description: 'Cria variante de um insumo, por exemplo uma cor.', inputSchema: z.object({ insumoId: z.number().int().positive(), nome: z.string().min(1).max(120) }) }, async ({ insumoId, nome }) => run(ready, () => criarVarianteAsync(insumoId, nome)))
  mcp.registerTool('renomear_variante_insumo', { description: 'Renomeia variante de um insumo.', inputSchema: z.object({ id: z.number().int().positive(), nome: z.string().min(1).max(120) }) }, async ({ id, nome }) => run(ready, () => renomearVarianteAsync(id, nome)))
  mcp.registerTool('compras', { description: 'Compras recentes dos insumos.', inputSchema: z.object({ limite: z.number().int().min(1).max(100).default(30) }), annotations: { readOnlyHint: true } }, async ({ limite }) => run(ready, () => listarComprasAsync(limite)))
  mcp.registerTool('registrar_compra_insumo', { description: 'Registra compra e entrada no estoque de um insumo.', inputSchema: z.object({ varianteId: z.number().int().positive(), quantidade: z.number().positive(), valor: z.number().nonnegative(), frete: z.number().nonnegative().default(0), fornecedor: z.string().max(150).optional() }) }, async (input) => run(ready, () => registrarCompraAsync(input)))
  mcp.registerTool('movimentos_estoque', { description: 'Movimentações recentes do estoque.', inputSchema: z.object({ limite: z.number().int().min(1).max(100).default(30) }), annotations: { readOnlyHint: true } }, async ({ limite }) => run(ready, () => listarMovimentosAsync(limite)))
  mcp.registerTool('ajustar_estoque_insumo', { description: 'Registra ajuste de estoque de uma variante de insumo.', inputSchema: z.object({ varianteId: z.number().int().positive(), quantidade: z.number().finite(), observacao: z.string().max(500).optional() }) }, async ({ varianteId, quantidade, observacao }) => run(ready, () => ajustarEstoqueAsync(varianteId, quantidade, observacao)))
  mcp.registerTool('fluxos_producao', { description: 'Etapas e ações dos fluxos de caixas e laços.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => run(ready, () => listProductionFlows()))
  mcp.registerTool('producao_do_pedido', { description: 'Etapa atual de cada item de um pedido.', inputSchema: z.object({ pedido: z.string().min(1).max(80) }), annotations: { readOnlyHint: true } }, async ({ pedido }) => run(ready, () => listOrderProduction(pedido)))
  mcp.registerTool('avancar_producao', { description: 'Executa uma ação do fluxo de produção para um item do pedido.', inputSchema: z.object({ pedido: z.string().min(1).max(80), itemId: z.string().max(80), modeloId: z.string().max(80), acao: z.enum(['RECEIVE_DATA', 'APPROVE_ART', 'PRINT_ART', 'CONFIRM_PRINT', 'ADVANCE']) }) }, async ({ pedido, itemId, modeloId, acao }) => run(ready, () => actOnProductionItem(pedido, itemId, modeloId, acao as ProductionActionKind)))
  mcp.registerTool('estado_sincronizacao', { description: 'Conexão com Shopee e progresso da sincronização em andamento.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => run(ready, async () => ({ conexao: await getConnectionStatus(), progresso: progressoLote(), tarefa: syncJob })))
  mcp.registerTool('previa_sincronizacao_pendente', { description: 'Mostra o que será atualizado ao sincronizar pendências.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => run(ready, () => pendingSyncPreview()))
  mcp.registerTool('sincronizar_pedidos', { description: 'Inicia sincronização de pedidos em segundo plano. Consulte estado_sincronizacao para acompanhar.', inputSchema: z.object({ paginas: z.number().int().min(1).max(100).default(2), apenasPendentes: z.boolean().default(false) }) }, async ({ paginas, apenasPendentes }) => run(ready, async () => {
    if (syncJob?.state === 'running' || progressoLote().rodando) return { iniciado: false, motivo: 'Já existe uma sincronização em andamento.' }
    syncJob = { state: 'running', startedAt: Date.now() }
    void syncAll(apenasPendentes ? { pendingOnly: true } : { pages: paginas }).then((outcome) => {
      if (syncJob) syncJob = { ...syncJob, state: outcome.ok ? 'done' : 'error', finishedAt: Date.now(), error: outcome.ok ? undefined : 'Falha na sincronização. Consulte o aplicativo.' }
    }).catch(() => {
      if (syncJob) syncJob = { ...syncJob, state: 'error', finishedAt: Date.now(), error: 'Falha na sincronização. Consulte o aplicativo.' }
    })
    return { iniciado: true, paginas: apenasPendentes ? null : paginas, apenasPendentes }
  }))
  return mcp
}

const tokenPath = (): string => join(app.getPath('userData'), 'mcp-lan-token')

async function lanToken(): Promise<string> {
  try {
    const token = (await readFile(tokenPath(), 'utf8')).trim()
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Chave MCP local inválida.')
    return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const token = randomBytes(32).toString('hex')
    try { await writeFile(tokenPath(), token, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return lanToken()
      throw error
    }
    return token
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
}

export async function startMcpServer(ready: () => Promise<void>): Promise<void> {
  const handler = createMcpHandler(() => createTools(ready))
  const nodeHandler = toNodeHandler(handler)
  const serve = (lan: boolean, token?: string): Server => createServer((req, res) => {
    const status = mcpAccessStatus({ url: req.url, method: req.method, host: req.headers.host, origin: req.headers.origin, authorization: req.headers.authorization }, {
      lan, token, localPort: LOCAL_PORT, lanPort: LAN_PORT,
      addresses: Object.values(networkInterfaces()).flat().filter((entry) => entry?.family === 'IPv4').map((entry) => entry!.address)
    })
    if (status !== null) { res.writeHead(status).end(); return }
    void nodeHandler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end() })
  })
  if (!localServer) {
    localServer = serve(false)
    await listen(localServer, LOCAL_PORT, '127.0.0.1')
  }
  if ((await getSettingsAsync()).mcpLanEnabled && !lanServer) {
    lanServer = serve(true, await lanToken())
    await listen(lanServer, LAN_PORT, '0.0.0.0')
  }
}

export async function refreshMcpLan(ready: () => Promise<void>): Promise<void> {
  if (lanServer) { await new Promise<void>((resolve) => lanServer?.close(() => resolve())); lanServer = null }
  if ((await getSettingsAsync()).mcpLanEnabled) await startMcpServer(ready)
}

export async function mcpStatus(): Promise<{ localUrl: string; localRunning: boolean; lanUrls: string[]; lanEnabled: boolean; lanRunning: boolean; lanToken: string | null }> {
  const enabled = (await getSettingsAsync()).mcpLanEnabled
  return { localUrl: `http://127.0.0.1:${LOCAL_PORT}/mcp`, localRunning: localServer?.listening ?? false, lanUrls: enabled ? Object.values(networkInterfaces()).flat().filter((entry) => entry?.family === 'IPv4' && !entry.internal).map((entry) => `http://${entry?.address}:${LAN_PORT}/mcp`) : [], lanEnabled: enabled, lanRunning: lanServer?.listening ?? false, lanToken: enabled ? await lanToken() : null }
}

export function stopMcpServer(): void {
  localServer?.close(); lanServer?.close(); localServer = null; lanServer = null
}
