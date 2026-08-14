import { app } from 'electron'
import { join } from 'path'
import { getDb } from '../db'
import type { AppSettings } from '@shared/types'

function defaults(): AppSettings {
  const docs = app?.getPath ? app.getPath('documents') : process.cwd()
  return {
    ordersRootDir: join(docs, 'CRM Seller', 'Pedidos'),
    templatesDir: join(docs, 'CRM Seller', 'Templates'),
    autoSyncEnabled: false,
    syncPageCount: 2,
    syncTracking: true,
    syncPayments: true,
    syncIntervalMinutes: 15
  }
}

export function getSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  return { ...defaults(), ...stored }
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const db = getDb()
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) upsert.run(key, JSON.stringify(value))
    }
  })
  tx()
  return getSettings()
}
