import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getSettingsAsync, updateSettingsAsync } from '../src/main/services/settings'

const root = await mkdtemp(join(tmpdir(), 'crm-settings-test-'))
process.env.CRM_SETTINGS_TEST_ROOT = root
try {
  await mkdir(join(root, 'userData'))
  const defaults = await getSettingsAsync()
  assert.equal(defaults.templatesDir, join(root, 'documents', 'CRM Seller', 'Templates'))
  assert.equal(defaults.mcpLanEnabled, false)
  const local = join(root, 'templates-custom')
  assert.equal((await updateSettingsAsync({ templatesDir: local })).templatesDir, local)
  assert.equal((await getSettingsAsync()).templatesDir, local)
  assert.equal((await updateSettingsAsync({ mcpLanEnabled: true })).mcpLanEnabled, true)
  assert.equal((await getSettingsAsync()).mcpLanEnabled, true)
  const saved = JSON.parse(await readFile(join(root, 'userData', 'folders.json'), 'utf8'))
  assert.equal(saved.templatesDir, local)
  await assert.rejects(updateSettingsAsync({ templatesDir: 'relative-folder' }))
  await assert.rejects(updateSettingsAsync({ mcpLanEnabled: 'sim' as unknown as boolean }))
  assert.equal((await getSettingsAsync()).templatesDir, local)
} finally {
  delete process.env.CRM_SETTINGS_TEST_ROOT
  await rm(root, { recursive: true, force: true })
}
