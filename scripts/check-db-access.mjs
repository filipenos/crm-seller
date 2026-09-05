import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

async function typescriptFiles(dir) {
  const result = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...await typescriptFiles(path))
    else if (entry.name.endsWith('.ts')) result.push(path)
  }
  return result
}

let failed = false
for (const file of await typescriptFiles('src/main')) {
  const path = relative('.', file)
  const source = await readFile(file, 'utf8')
  const blockingCalls = source.match(/\bgetDb\s*\(/g)?.length ?? 0
  const syncImports = source.match(/from\s+['"]libsql(?:\/promise)?['"]/g)?.length ?? 0
  if (blockingCalls > 0 || syncImports > 0) {
    console.error(
      `${path}: ${blockingCalls} chamada(s) bloqueante(s), ${syncImports} importação(ões) síncrona(s)`
    )
    failed = true
  }
}

if (failed) {
  console.error('Use getAsyncDb() para toda nova consulta ao Turso.')
  process.exitCode = 1
}
