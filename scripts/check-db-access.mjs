import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

// Limite temporário do legado. Novos acessos bloqueantes são proibidos; ao
// migrar um arquivo, o número real cai e este teto pode ser reduzido depois.
const legacyLimits = new Map(Object.entries({
  'src/main/services/events.ts': 5,
  'src/main/services/insumos.ts': 15,
  'src/main/services/orders.ts': 19,
  'src/main/services/produtos.ts': 4,
  'src/main/services/recebimentos.ts': 8,
  'src/main/services/receitas.ts': 20,
  'src/main/services/seed.ts': 1,
  'src/main/services/settings.ts': 2,
  'src/main/services/shopee/accountBinding.ts': 3,
  'src/main/services/shopee/probe.ts': 1,
  'src/main/services/stages.ts': 7
}))

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
for (const file of await typescriptFiles('src/main/services')) {
  const path = relative('.', file)
  const source = await readFile(file, 'utf8')
  const count = source.match(/\bgetDb\s*\(/g)?.length ?? 0
  const limit = legacyLimits.get(path) ?? 0
  if (count > limit) {
    console.error(`${path}: ${count} acessos bloqueantes; limite atual ${limit}`)
    failed = true
  }
}

if (failed) {
  console.error('Use getAsyncDb() para toda nova consulta ao Turso.')
  process.exitCode = 1
}
