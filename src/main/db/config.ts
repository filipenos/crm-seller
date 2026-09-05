import { app, safeStorage } from 'electron'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface TursoCredentials {
  url: string
  authToken: string
}

interface StoredConfig {
  url: string
  encryptedAuthToken?: string
  authToken?: string
}

const CONFIG_FILE = 'turso.json'

function configPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE)
}

export function normalizeTursoUrl(value: string): string {
  const url = value.trim().replace(/\/$/, '')
  if (!/^(libsql|https):\/\/[^\s]+$/i.test(url)) {
    throw new Error('Informe uma URL do Turso válida (libsql:// ou https://).')
  }
  return url
}

export function hasTursoConfig(): boolean {
  return Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) || existsSync(configPath())
}

export function readTursoConfig(): TursoCredentials | null {
  if (process.env.NODE_ENV === 'test' && process.env.CRM_SELLER_TEST_DATABASE_URL) {
    return { url: process.env.CRM_SELLER_TEST_DATABASE_URL, authToken: '' }
  }
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    return {
      url: normalizeTursoUrl(process.env.TURSO_DATABASE_URL),
      authToken: process.env.TURSO_AUTH_TOKEN
    }
  }

  if (!existsSync(configPath())) return null

  try {
    const stored = JSON.parse(readFileSync(configPath(), 'utf8')) as StoredConfig
    const authToken = stored.encryptedAuthToken
      ? safeStorage.decryptString(Buffer.from(stored.encryptedAuthToken, 'base64'))
      : stored.authToken
    if (!authToken) throw new Error('credencial ausente')
    return {
      url: normalizeTursoUrl(stored.url),
      authToken
    }
  } catch {
    throw new Error('Não foi possível ler a configuração local do Turso. Configure a conexão novamente.')
  }
}

export function writeTursoConfig(input: TursoCredentials): void {
  const url = normalizeTursoUrl(input.url)
  const authToken = input.authToken.trim()
  if (!authToken) throw new Error('Informe o token de autenticação do Turso.')
  const path = configPath()
  const temporaryPath = `${path}.tmp`
  const stored: StoredConfig = safeStorage.isEncryptionAvailable()
    ? {
        url,
        encryptedAuthToken: safeStorage.encryptString(authToken).toString('base64')
      }
    : { url, authToken }
  writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporaryPath, path)
  chmodSync(path, 0o600)
}

export function publicTursoConfig(): { configured: boolean; url: string | null } {
  if (!hasTursoConfig()) return { configured: false, url: null }
  try {
    return { configured: true, url: readTursoConfig()?.url ?? null }
  } catch {
    return { configured: false, url: null }
  }
}
