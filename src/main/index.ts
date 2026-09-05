import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { closeDb, prepareTursoDatabaseAsync } from './db'
import { registerIpcHandlers } from './ipc'
import { garantirCadastroDeFabricacaoAsync } from './services/seed'
import { recomporCatalogoDosPedidosAsync } from './services/produtos'
import { startSyncScheduler, stopSyncScheduler } from './services/shopee/sync'
import { initUpdater, stopUpdater } from './services/updates'
import { hasTursoConfig, readTursoConfig } from './db/config'
import { getSettingsAsync } from './services/settings'

let servicesStart: Promise<void> | null = null

async function startServices(reset = false): Promise<void> {
  if (reset) servicesStart = null
  if (servicesStart) return servicesStart
  servicesStart = (async () => {
    const credentials = readTursoConfig()
    if (!credentials) throw new Error('Configure a conexão com o Turso antes de usar o aplicativo.')
    await prepareTursoDatabaseAsync(credentials, () => undefined)
    await garantirCadastroDeFabricacaoAsync()
    await recomporCatalogoDosPedidosAsync()
    startSyncScheduler(await getSettingsAsync())
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers(startServices)
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  stopSyncScheduler()
  stopUpdater()
  closeDb()
})
