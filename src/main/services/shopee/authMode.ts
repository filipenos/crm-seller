import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export type ShopeeAuthMode = 'app' | 'chrome'

const APP_PARTITION = 'persist:shopee'
const CHROME_PARTITION = 'persist:shopee-chrome'
let cachedMode: ShopeeAuthMode | null = null
let cachedChromeUserAgent: string | null = null
let loaded = false

function modePath(): string {
  return join(app.getPath('userData'), 'shopee-auth-mode.json')
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const stored = JSON.parse(readFileSync(modePath(), 'utf8')) as { mode?: unknown; chromeUserAgent?: unknown }
    cachedMode = stored.mode === 'chrome' ? 'chrome' : 'app'
    cachedChromeUserAgent = typeof stored.chromeUserAgent === 'string' ? stored.chromeUserAgent : null
  } catch {
    cachedMode = 'app'
  }
}

function save(): void {
  const path = modePath()
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, JSON.stringify({ mode: cachedMode, chromeUserAgent: cachedChromeUserAgent }), { mode: 0o600 })
  renameSync(temporaryPath, path)
}

export function getShopeeAuthMode(): ShopeeAuthMode {
  load()
  return cachedMode ?? 'app'
}

export function setShopeeAuthMode(mode: ShopeeAuthMode): void {
  if (mode !== 'app' && mode !== 'chrome') throw new Error('Modo de conexão inválido.')
  cachedMode = mode
  save()
}

export function getChromeUserAgent(): string | null {
  load()
  return cachedChromeUserAgent
}

export function setChromeUserAgent(value: string): void {
  if (value.length > 512 || !/Chrome\/\d+/.test(value)) throw new Error('Navegador incompatível.')
  load()
  cachedChromeUserAgent = value
  save()
}

export function shopeePartition(): string {
  return getShopeeAuthMode() === 'chrome' ? CHROME_PARTITION : APP_PARTITION
}

export function chromeShopeePartition(): string {
  return CHROME_PARTITION
}

export function appShopeePartition(): string {
  return APP_PARTITION
}
