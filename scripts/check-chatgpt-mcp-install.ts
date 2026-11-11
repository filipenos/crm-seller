import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatgptMcpInstallation, installChatgptMcp } from '../src/main/services/chatgptMcpInstall'

const dir = await mkdtemp(join(tmpdir(), 'crm-mcp-install-'))
try {
  const path = join(dir, '.codex', 'config.toml')
  assert.equal((await chatgptMcpInstallation(path)).installed, false)
  await installChatgptMcp(path)
  assert.equal((await chatgptMcpInstallation(path)).installed, true)
  const first = await readFile(path, 'utf8')
  assert.match(first, /\[mcp_servers\.crm_seller\]/)
  await installChatgptMcp(path)
  assert.equal(await readFile(path, 'utf8'), first)

  const existing = '[projects."/example"]\r\ntrust_level = "trusted"\r\n'
  await writeFile(path, existing)
  await installChatgptMcp(path)
  const result = await readFile(path, 'utf8')
  assert.ok(result.startsWith(existing))
  assert.match(result, /\r\n\[mcp_servers\.crm_seller\]\r\n/)
  const backup = (await readdir(join(dir, '.codex'))).find((name) => name.startsWith('config.toml.crm-seller-backup-'))
  assert.ok(backup)
  assert.equal(await readFile(join(dir, '.codex', backup), 'utf8'), existing)

  await writeFile(path, '[mcp_servers.crm_seller]\nurl = "https://example.com/mcp"\n')
  await assert.rejects(() => installChatgptMcp(path), /Já existe uma configuração/)
  assert.match(await readFile(path, 'utf8'), /example\.com/)
} finally {
  await rm(dir, { recursive: true, force: true })
}
