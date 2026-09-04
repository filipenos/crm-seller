import Database from 'libsql'
import PromiseDatabase from 'libsql/promise'
import { MIGRATION_COUNT, migrationStatements, runMigrations } from './migrations'
import { readTursoConfig, type TursoCredentials } from './config'

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

export async function prepareTursoDatabaseAsync(
  credentials: TursoCredentials,
  onProgress: (message: string) => void
): Promise<void> {
  const candidate = new PromiseDatabase(credentials.url, { authToken: credentials.authToken })
  try {
    const run = async (sql: string, parameters: unknown[] = []): Promise<void> => {
      const statement = await candidate.prepare(sql)
      await statement.run(parameters)
    }
    await run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
    const versionStatement = await candidate.prepare(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
    )
    const row = (await versionStatement.get([])) as { version: number }
    const currentVersion = Number(row.version)
    if (currentVersion < MIGRATION_COUNT) onProgress('Preparando as tabelas do banco…')
    for (let i = currentVersion; i < MIGRATION_COUNT; i++) {
      for (const statement of migrationStatements(i)) await run(statement)
      await run('INSERT INTO schema_migrations (version) VALUES (?)', [i + 1])
      onProgress(`Aplicando migrações… ${i + 1}/${MIGRATION_COUNT}`)
    }
    onProgress('Verificando se o banco está pronto…')
    const tableStatement = await candidate.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    const tables = (await tableStatement.all([])) as { name: string }[]
    const existing = new Set(tables.map((table) => table.name))
    const required = ['settings', 'orders', 'supplies', 'production_lines', 'recipes']
    const missing = required.filter((table) => !existing.has(table))
    if (missing.length > 0) {
      throw new Error(`O banco Turso está incompleto. Tabelas ausentes: ${missing.join(', ')}.`)
    }
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
