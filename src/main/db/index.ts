import { createClient, type Client, type InValue } from '@libsql/client'
import { MIGRATION_COUNT, migrationStatements } from './migrations'
import { readTursoConfig, type TursoCredentials } from './config'

export interface AsyncRunResult {
  changes: number
  lastInsertRowid: bigint | undefined
}

export interface AsyncStatement {
  run(parameters?: unknown[]): Promise<AsyncRunResult>
  get(parameters?: unknown[]): Promise<unknown>
  all(parameters?: unknown[]): Promise<unknown[]>
}

export interface AsyncDatabase {
  prepare(sql: string): Promise<AsyncStatement>
  close(): void
}

class TursoStatement implements AsyncStatement {
  constructor(
    private readonly client: Client,
    private readonly sql: string
  ) {}

  private args(parameters: unknown[] = []): InValue[] {
    return parameters.map((value) => {
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'bigint' ||
        value instanceof Uint8Array
      ) {
        return value
      }
      if (typeof value === 'boolean') return value ? 1 : 0
      throw new TypeError(`Parâmetro SQL inválido: ${typeof value}`)
    })
  }

  async run(parameters: unknown[] = []): Promise<AsyncRunResult> {
    const result = await this.client.execute({ sql: this.sql, args: this.args(parameters) })
    return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid }
  }

  async get(parameters: unknown[] = []): Promise<unknown> {
    const result = await this.client.execute({ sql: this.sql, args: this.args(parameters) })
    return result.rows[0]
  }

  async all(parameters: unknown[] = []): Promise<unknown[]> {
    const result = await this.client.execute({ sql: this.sql, args: this.args(parameters) })
    return [...result.rows]
  }
}

class TursoDatabase implements AsyncDatabase {
  constructor(private readonly client: Client) {}

  async prepare(sql: string): Promise<AsyncStatement> {
    return new TursoStatement(this.client, sql)
  }

  close(): void {
    this.client.close()
  }
}

function openDatabase(credentials: TursoCredentials): AsyncDatabase {
  return new TursoDatabase(
    createClient({
      url: credentials.url,
      authToken: credentials.authToken,
      intMode: 'number'
    })
  )
}

let asyncDb: AsyncDatabase | null = null

export async function prepareTursoDatabaseAsync(
  credentials: TursoCredentials,
  onProgress: (message: string) => void
): Promise<void> {
  const candidate = openDatabase(credentials)
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

/** Conexão não bloqueante para operações longas executadas no processo principal. */
export function getAsyncDb(): AsyncDatabase {
  if (!asyncDb) {
    const config = readTursoConfig()
    if (!config) throw new Error('Configure a conexão com o Turso antes de usar o aplicativo.')
    asyncDb = openDatabase(config)
  }
  return asyncDb
}

export function closeDb(): void {
  if (asyncDb) {
    asyncDb.close()
    asyncDb = null
  }
}
