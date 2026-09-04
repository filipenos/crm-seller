import Database from 'libsql'
import { MIGRATION_COUNT, runMigrations } from './migrations'
import { normalizeTursoUrl, readTursoConfig, type TursoCredentials } from './config'

let db: Database.Database | null = null

function openRemote(url: string, authToken: string): Database.Database {
  // As definições do pacote ainda não expõem authToken, embora a API oficial exponha.
  const remote = new Database(url, { authToken } as Database.Options)
  installRemoteStatementAdapter(remote)
  installRemoteTransactionAdapter(remote)
  return remote
}

function installRemoteStatementAdapter(remote: Database.Database): void {
  const prepare = remote.prepare.bind(remote)
  remote.prepare = ((sql: string) => {
    const statement = prepare(sql)
    const mutable = statement as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const method of ['run', 'get', 'all'] as const) {
      const execute = statement[method].bind(statement) as (...args: unknown[]) => unknown
      mutable[method] = (...args: unknown[]) => {
        if (args.length === 1 && (Array.isArray(args[0]) || isNamedBindings(args[0]))) {
          return execute(args[0])
        }
        return execute(args)
      }
    }
    return statement
  }) as typeof remote.prepare
}

function isNamedBindings(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Buffer.isBuffer(value)
}

function installRemoteTransactionAdapter(remote: Database.Database): void {
  remote.transaction = ((fn: (...args: unknown[]) => unknown) => {
    // A API síncrona do libsql já transaciona cada statement Hrana e rejeita
    // BEGIN explícito. Mantemos a interface usada pelos serviços e a ordem das
    // operações; erros continuam subindo, mas não há rollback entre statements.
    const wrap = () => (...args: unknown[]): unknown => fn(...args)
    type Wrapped = (...args: unknown[]) => unknown
    const transaction = wrap() as Wrapped & {
      default: Wrapped
      deferred: Wrapped
      immediate: Wrapped
      exclusive: Wrapped
    }
    transaction.default = transaction
    transaction.deferred = wrap()
    transaction.immediate = wrap()
    transaction.exclusive = wrap()
    return transaction
  }) as unknown as typeof remote.transaction
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

export function prepareTursoDatabase(credentials: TursoCredentials): void {
  const candidate = openRemote(credentials.url, credentials.authToken)
  try {
    candidate.pragma('foreign_keys = ON')
    runMigrations(candidate)
    verifyDatabaseReady(candidate)
  } finally {
    candidate.close()
  }
}

function verifyDatabaseReady(candidate: Database.Database): void {
  const version = candidate
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number }
  if (Number(version.version) !== MIGRATION_COUNT) {
    throw new Error('O banco Turso não concluiu todas as migrações.')
  }
  const required = ['settings', 'orders', 'supplies', 'production_lines', 'recipes']
  const tables = candidate
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[]
  const existing = new Set(tables.map((table) => table.name))
  const missing = required.filter((table) => !existing.has(table))
  if (missing.length > 0) {
    throw new Error(`O banco Turso está incompleto. Tabelas ausentes: ${missing.join(', ')}.`)
  }
  candidate.prepare('SELECT 1 FROM settings LIMIT 1').get()
}

export function getDb(): Database.Database {
  if (!db) {
    const config = readTursoConfig()
    if (!config) throw new Error('Configure a conexão com o Turso antes de usar o aplicativo.')

    db = openRemote(config.url, config.authToken)
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    verifyDatabaseReady(db)
  }
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
