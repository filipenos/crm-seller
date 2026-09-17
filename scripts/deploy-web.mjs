import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

function localEnvironment() {
  try {
    const text = readFileSync(resolve('.env.cloudflare'), 'utf8')
    return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return []
      const separator = trimmed.indexOf('=')
      if (separator < 1) return []
      const key = trimmed.slice(0, separator).trim()
      let value = trimmed.slice(separator + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      return [[key, value]]
    }))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

const local = localEnvironment()
const value = (name) => process.env[name] || local[name] || ''
const required = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']
const missing = required.filter((name) => !value(name))
if (missing.length > 0) {
  console.error(`Preencha as variáveis ausentes: ${missing.join(', ')}`)
  process.exit(1)
}

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const env = { ...process.env }
if (value('CLOUDFLARE_ACCOUNT_ID')) env.CLOUDFLARE_ACCOUNT_ID = value('CLOUDFLARE_ACCOUNT_ID')
if (value('CLOUDFLARE_API_TOKEN')) env.CLOUDFLARE_API_TOKEN = value('CLOUDFLARE_API_TOKEN')

function run(args, input) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, input, stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(['wrangler', 'secret', 'bulk'], JSON.stringify({
  TURSO_DATABASE_URL: value('TURSO_DATABASE_URL'),
  TURSO_AUTH_TOKEN: value('TURSO_AUTH_TOKEN')
}))
run(['vite', 'build', '--config', 'vite.web.config.ts'])
run(['tsc', '--noEmit', '-p', 'tsconfig.worker.json'])
run(['wrangler', 'deploy'])
