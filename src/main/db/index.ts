import Database from 'libsql'
import { runMigrations } from './migrations'
import { normalizeTursoUrl, readTursoConfig, type TursoCredentials } from './config'

let db: Database.Database | null = null

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

export async function waitForTursoConnection(credentials: TursoCredentials): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      testTursoConnection(credentials)
      return
    } catch (error) {
      lastError = error
      if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError
}

export function getDb(): Database.Database {
  if (!db) {
    const config = readTursoConfig()
    if (!config) throw new Error('Configure a conexão com o Turso antes de usar o aplicativo.')

    db = openRemote(config.url, config.authToken)
    db.pragma('foreign_keys = ON')
    runMigrations(db)
  }
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
