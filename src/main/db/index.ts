import Database from 'libsql'
import { app } from 'electron'
import { createHash } from 'crypto'
import { join } from 'path'
import { runMigrations } from './migrations'
import { normalizeTursoUrl, readTursoConfig, type TursoCredentials } from './config'

let db: Database.Database | null = null

function replicaPath(url: string): string {
  const id = createHash('sha256').update(url).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), `crm-seller-${id}.db`)
}

function openRemote(url: string, authToken: string): Database.Database {
  // As definições do pacote ainda não expõem authToken, embora a API oficial exponha.
  return new Database(url, { authToken } as Database.Options)
}

export function testTursoConnection(credentials: TursoCredentials): void {
  const url = normalizeTursoUrl(credentials.url)
  const authToken = credentials.authToken.trim()
  if (!authToken) throw new Error('Informe o token de autenticação do Turso.')
  const testDb = openRemote(url, authToken)
  try {
    testDb.prepare('SELECT 1 AS ok').get()
  } finally {
    testDb.close()
  }
}

export function getDb(): Database.Database {
  if (!db) {
    const config = readTursoConfig()
    if (!config) throw new Error('Configure a conexão com o Turso antes de usar o aplicativo.')

    db = new Database(replicaPath(config.url), {
      syncUrl: config.url,
      authToken: config.authToken
    } as Database.Options)
    db.sync()
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    db.sync()
  }
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
