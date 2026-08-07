import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { getSettings } from './settings'

/**
 * Atualização automática pelas Releases do GitHub (electron-updater).
 *
 * O app instalado checa sozinho, baixa em segundo plano e instala ao fechar —
 * o usuário só reinstala uma vez, na primeira instalação. O botão "Reiniciar e
 * instalar" antecipa isso.
 *
 * O repositório vem gravado no instalador (`app-update.yml`, gerado pela config
 * `publish` do electron-builder). Em desenvolvimento nada disso roda: só o app
 * empacotado sabe se atualizar.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 8000

const status: UpdateStatus = {
  state: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: null,
  percent: null,
  error: null,
  checkedAt: null
}

let timer: NodeJS.Timeout | null = null

function patch(next: Partial<UpdateStatus>): void {
  Object.assign(status, next)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', { ...status })
  }
}

/**
 * Permite apontar para outro repositório sem regerar o instalador (campo em
 * Configurações). Vazio — o normal — mantém o que veio no instalador.
 */
function applyFeedOverride(): void {
  try {
    const repo = getSettings().githubRepo.trim()
    if (repo === '') return
    const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repo)
    if (!match) {
      patch({ error: `Repositório de atualização inválido: "${repo}" (use dono/repo).` })
      return
    }
    autoUpdater.setFeedURL({ provider: 'github', owner: match[1], repo: match[2] })
  } catch (err) {
    console.warn('[update] não foi possível aplicar o repositório configurado:', err)
  }
}

export function initUpdater(): void {
  if (!app.isPackaged) {
    patch({ state: 'unsupported' })
    console.log('[update] modo dev — atualização automática desativada')
    return
  }

  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  // Instala ao fechar o app: é o que faz a atualização acontecer sozinha.
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => patch({ state: 'checking', error: null }))
  autoUpdater.on('update-available', (info) =>
    patch({ state: 'downloading', latestVersion: info.version, percent: 0, error: null })
  )
  autoUpdater.on('update-not-available', (info) =>
    patch({
      state: 'up-to-date',
      latestVersion: info.version,
      percent: null,
      error: null,
      checkedAt: Date.now()
    })
  )
  autoUpdater.on('download-progress', (progress) =>
    patch({ state: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    patch({
      state: 'downloaded',
      latestVersion: info.version,
      percent: 100,
      error: null,
      checkedAt: Date.now()
    })
  )
  autoUpdater.on('error', (err) =>
    patch({ state: 'error', error: String(err instanceof Error ? err.message : err) })
  )

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS)
  timer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
}

export function stopUpdater(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status }
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    patch({
      state: 'unsupported',
      error: 'Atualização automática só funciona no app instalado.'
    })
    return getUpdateStatus()
  }
  // Já baixou: checar de novo só apagaria o aviso de "pronto para instalar".
  if (status.state === 'downloaded') return getUpdateStatus()

  try {
    applyFeedOverride()
    await autoUpdater.checkForUpdates()
  } catch (err) {
    patch({ state: 'error', error: String(err instanceof Error ? err.message : err) })
  }
  return getUpdateStatus()
}

/** Fecha e instala a versão já baixada. */
export function installUpdate(): boolean {
  if (status.state !== 'downloaded') return false
  // Fora do handler do IPC, para a resposta chegar ao renderer antes do quit.
  setImmediate(() => autoUpdater.quitAndInstall())
  return true
}
