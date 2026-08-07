import { cp, mkdir, readdir, rename, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { shell } from 'electron'
import type { ActionResult, Order } from '@shared/types'
import { getSettings } from './settings'
import { getOrder, setFolderPath } from './orders'
import { listMessagesForOrder } from './messages'

/** Remove caracteres inválidos para nome de pasta/arquivo no Windows. */
function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim()
}

function orderFolderName(order: Order): string {
  const child = order.childName ? ` - ${sanitize(order.childName)}` : ''
  return `${sanitize(order.orderSn)}${child}`
}

/** Substitui o placeholder {NOME} em nomes de arquivos copiados do template. */
async function applyNamePlaceholders(dir: string, childName: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await applyNamePlaceholders(fullPath, childName)
    }
    if (entry.name.includes('{NOME}')) {
      const newName = entry.name.replaceAll('{NOME}', sanitize(childName))
      await rename(fullPath, join(dir, newName))
    }
  }
}

function buildInfoFile(order: Order): string {
  const lines: string[] = [
    `Pedido: ${order.orderSn}`,
    `Comprador: ${order.buyerName ?? order.buyerUsername ?? '-'}`,
    `Usuário Shopee: ${order.buyerUsername ?? '-'}`,
    `Nome (personalização): ${order.childName ?? '(não informado)'}`,
    `Status Shopee: ${order.shopeeStatus ?? '-'}`,
    `Rastreio: ${order.trackingNumber ?? '-'}`,
    '',
    'Itens:'
  ]
  for (const item of order.items) {
    lines.push(
      `  - ${item.quantity}x ${item.itemName}${item.modelName ? ` (${item.modelName})` : ''}`
    )
  }
  if (order.note) {
    lines.push('', `Observações: ${order.note}`)
  }
  const messages = listMessagesForOrder(order.orderSn).filter((m) => m.direction === 'in')
  if (messages.length > 0) {
    lines.push('', 'Mensagens do cliente:')
    for (const m of messages) {
      const when = new Date(m.createdAt).toLocaleString('pt-BR')
      lines.push(`  [${when}] ${m.content}`)
    }
  }
  return lines.join('\n')
}

/**
 * Cria a pasta do pedido a partir do template e grava um resumo
 * (pedido-info.txt) com itens, nome da criança e mensagens do cliente.
 */
export async function createOrderFolder(orderSn: string): Promise<ActionResult> {
  const order = getOrder(orderSn)
  if (!order) return { ok: false, error: `Pedido ${orderSn} não encontrado` }

  const settings = getSettings()
  const folderPath = join(settings.ordersRootDir, orderFolderName(order))

  try {
    await mkdir(folderPath, { recursive: true })

    if (existsSync(settings.templatesDir)) {
      const templates = await readdir(settings.templatesDir)
      for (const name of templates) {
        const target = join(folderPath, name)
        if (!existsSync(target)) {
          await cp(join(settings.templatesDir, name), target, { recursive: true })
        }
      }
      if (order.childName) {
        await applyNamePlaceholders(folderPath, order.childName)
      }
    }

    await writeFile(join(folderPath, 'pedido-info.txt'), buildInfoFile(order), 'utf-8')
    setFolderPath(orderSn, folderPath)
    return { ok: true, path: folderPath }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

export async function openOrderFolder(orderSn: string): Promise<ActionResult> {
  const order = getOrder(orderSn)
  if (!order?.folderPath || !existsSync(order.folderPath)) {
    const created = await createOrderFolder(orderSn)
    if (!created.ok) return created
    await shell.openPath(created.path!)
    return created
  }
  const error = await shell.openPath(order.folderPath)
  return error ? { ok: false, error } : { ok: true, path: order.folderPath }
}

/** Renomeia a pasta se o nome da criança mudou depois de criada (mantém conteúdo). */
export async function ensureFolderName(orderSn: string): Promise<void> {
  const order = getOrder(orderSn)
  if (!order?.folderPath || !existsSync(order.folderPath)) return
  const expected = join(getSettings().ordersRootDir, orderFolderName(order))
  if (expected !== order.folderPath && basename(expected) !== basename(order.folderPath)) {
    if (!existsSync(expected)) {
      await rename(order.folderPath, expected)
      setFolderPath(orderSn, expected)
    }
  }
}
