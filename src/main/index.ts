import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { closeDb, prepareTursoDatabaseAsync } from './db'
import { registerIpcHandlers } from './ipc'
import { garantirCadastroDeFabricacaoAsync } from './services/seed'
import { recomporCatalogoDosPedidosAsync } from './services/produtos'
import { initUpdater, stopUpdater } from './services/updates'
import { hasTursoConfig, readTursoConfig } from './db/config'
import { ensureDefaultComposition } from './services/composition'
import { startBrowserBridge, stopBrowserBridge } from './services/shopee/browserBridge'
import { startMcpServer, stopMcpServer } from './services/mcpServer'

// Idioma fixo do Chromium/Electron: controles nativos, calendário, menus do
// sistema e mensagens internas não devem variar com o idioma do computador.
app.commandLine.appendSwitch('lang', 'pt-BR')

let servicesStart: Promise<void> | null = null

async function startServices(reset = false): Promise<void> {
  if (reset) servicesStart = null
  if (servicesStart) return servicesStart
  servicesStart = (async () => {
    const credentials = readTursoConfig()
    if (!credentials) throw new Error('Configure a conexão com o Turso antes de usar o aplicativo.')
    await prepareTursoDatabaseAsync(credentials, () => undefined)
    await garantirCadastroDeFabricacaoAsync()
    await ensureDefaultComposition()
    await recomporCatalogoDosPedidosAsync()
    initUpdater()
  })()
  try {
    await servicesStart
  } catch (error) {
    servicesStart = null
    throw error
  }
}

function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'CRM Seller',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // A Shopee mantém uma janela oculta para as APIs. Ela não deve impedir que
  // fechar a janela principal encerre o aplicativo no Windows e no Linux.
  win.once('closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  void startBrowserBridge().catch((error) => {
    console.error('Ponte local com Chrome indisponível:', error instanceof Error ? error.message : error)
  })
  registerIpcHandlers(startServices)
  void startMcpServer(() => startServices()).catch(() => {
    console.error('Servidor MCP local indisponível.')
  })
  if (hasTursoConfig()) {
    void startServices().catch((error) => {
      console.error('Falha ao inicializar o Turso:', error instanceof Error ? error.message : error)
    })
  }
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('will-quit', () => {
  stopBrowserBridge()
  stopMcpServer()
  stopUpdater()
  closeDb()
})
