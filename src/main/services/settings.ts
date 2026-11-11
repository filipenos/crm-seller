import { app } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppSettings } from '@shared/types'

function defaults(): AppSettings {
  const docs = app.getPath('documents')
  return {
    ordersRootDir: join(docs, 'CRM Seller', 'Pedidos'),
    templatesDir: join(docs, 'CRM Seller', 'Templates'),
    mcpLanEnabled: false,
  }
}

const settingsPath = (): string => join(app.getPath('userData'), 'folders.json')

export async function getSettingsAsync(): Promise<AppSettings> {
  let stored: unknown
  try {
    stored = JSON.parse(await readFile(settingsPath(), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults()
    throw error
  }
  if (!stored || typeof stored !== 'object') throw new Error('Configuração local de pastas inválida.')
  const value = stored as Partial<AppSettings>
  const result = { ...defaults(), ...value }
  if (typeof result.ordersRootDir !== 'string' || typeof result.templatesDir !== 'string' ||
    !isAbsolute(result.ordersRootDir) || !isAbsolute(result.templatesDir) ||
    typeof result.mcpLanEnabled !== 'boolean') throw new Error('Configuração local inválida.')
  return result
}

export async function updateSettingsAsync(partial: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...await getSettingsAsync(), ...partial }
  for (const key of ['ordersRootDir', 'templatesDir'] as const) {
    if (typeof next[key] !== 'string' || !isAbsolute(next[key]) || next[key].trim() !== next[key]) {
      throw new Error('Escolha uma pasta válida neste computador.')
    }
  }
  if (typeof next.mcpLanEnabled !== 'boolean') throw new Error('Configuração MCP inválida.')
  const path = settingsPath()
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(next), { mode: 0o600 })
  await rename(temp, path)
  return next
}
