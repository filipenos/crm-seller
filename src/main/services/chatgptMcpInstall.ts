import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFile, mkdir, writeFile, rename, copyFile, unlink } from 'node:fs/promises'

export const CHATGPT_MCP_URL = 'http://127.0.0.1:38765/mcp'
const SECTION = '[mcp_servers.crm_seller]'
const ENTRY = `${SECTION}\nurl = "${CHATGPT_MCP_URL}"\n`

export interface ChatgptMcpInstallation {
  configPath: string
  installed: boolean
}

export function chatgptConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml')
}

async function currentConfig(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function serverSection(config: string): string | null {
  const lines = config.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === SECTION)
  if (start < 0) return null
  const end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

function isInstalled(config: string): boolean {
  const section = serverSection(config)
  return section !== null && /^\s*url\s*=\s*["']http:\/\/127\.0\.0\.1:38765\/mcp["']\s*(?:#.*)?$/m.test(section)
}

export async function chatgptMcpInstallation(configPath = chatgptConfigPath()): Promise<ChatgptMcpInstallation> {
  return { configPath, installed: isInstalled(await currentConfig(configPath)) }
}

export async function installChatgptMcp(configPath = chatgptConfigPath()): Promise<ChatgptMcpInstallation> {
  const current = await currentConfig(configPath)
  if (isInstalled(current)) return { configPath, installed: true }
  if (serverSection(current) !== null) {
    throw new Error('Já existe uma configuração crm_seller com outro endereço. Remova essa entrada antes de instalar novamente.')
  }

  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  const separator = current ? (current.endsWith(newline) ? newline : `${newline}${newline}`) : ''
  const next = current + separator + ENTRY.replace(/\n/g, newline)
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const tempPath = `${configPath}.crm-seller-tmp`
  try {
    await writeFile(tempPath, next, { mode: 0o600, flag: 'wx' })
    if (current) await copyFile(configPath, `${configPath}.crm-seller-backup-${Date.now()}`)
    await rename(tempPath, configPath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
  return { configPath, installed: true }
}
