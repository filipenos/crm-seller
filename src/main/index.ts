import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { getDb, closeDb } from './db'
import { registerIpcHandlers } from './ipc'
import { garantirCadastroDeFabricacao } from './services/seed'
import { recomporCatalogoDosPedidos } from './services/produtos'
import { startSyncScheduler, stopSyncScheduler } from './services/shopee/sync'
import { initUpdater, stopUpdater } from './services/updates'

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
  getDb() // inicializa banco + migrações
  // Só age em base virgem: o kit de hoje é sempre o mesmo, então a página de
  // fabricação já abre com os cinco modelos e os insumos para corrigir.
  garantirCadastroDeFabricacao()
  // O catálogo sai dos pedidos que já estão no banco, sem rede — então a página
  // de produtos abre cheia mesmo antes da primeira sincronização.
  recomporCatalogoDosPedidos()
  registerIpcHandlers()
  createMainWindow()
  startSyncScheduler()
  initUpdater()

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
