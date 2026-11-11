import { app, dialog, shell } from 'electron'
import { copyFile, cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { ArtField, ArtTheme } from '@shared/artEditor'
import { layoutText, outlineSamples, shadowOrigin, shadowSamples } from '@shared/artGeometry'
import { getSettingsAsync } from './settings'
import { getAsyncDb } from '../db'
import { createOrderFolder } from './folders'
import { markOrderArtGenerated } from './production'

let cachedRoot: string | null = null
const orderFolderCache = new Map<string, string>()
export function invalidateArtThemeRoot(): void { cachedRoot = null }
export async function copyArtThemes(from: string, to: string): Promise<void> {
  if (from === to) return
  await mkdir(to, { recursive: true })
  const entries = await readdir(from, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId(entry.name)) continue
    const source = join(from, entry.name)
    const manifest = await readFile(join(source, 'theme.json'), 'utf8').catch(() => '')
    if (!manifest) continue
    const target = join(to, entry.name)
    const existing = await readdir(to)
    if (!existing.includes(entry.name)) await cp(source, target, { recursive: true })
  }
}
const root = async (): Promise<string> => {
  if (!cachedRoot) cachedRoot = (await getSettingsAsync()).templatesDir
  return cachedRoot
}
const validId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id)
const slug = (name: string): string => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70)
const themePath = async (id: string): Promise<string> => {
  if (!validId(id)) throw new Error('Tema inválido.')
  return join(await root(), id)
}

async function saveTheme(theme: ArtTheme): Promise<void> {
  const folder = await themePath(theme.id)
  const temp = join(folder, `theme-${randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify(theme), 'utf8')
  await rename(temp, join(folder, 'theme.json'))
}

export async function listArtThemes(): Promise<ArtTheme[]> {
  const directory = await root()
  await mkdir(directory, { recursive: true })
  const entries = await readdir(directory, { withFileTypes: true })
  const themes: ArtTheme[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId(entry.name)) continue
    try {
      const theme = JSON.parse(await readFile(join(directory, entry.name, 'theme.json'), 'utf8')) as ArtTheme
      if (theme.id === entry.name && Array.isArray(theme.pages)) {
        themes.push({ ...theme, pages: theme.pages.map((page) => ({ ...page, label: page.label || page.file })) })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
}

export async function createArtTheme(name: string): Promise<ArtTheme> {
  const clean = name.trim()
  if (!clean || clean.length > 100) throw new Error('Informe um nome de até 100 caracteres.')
  const directory = await root()
  await mkdir(directory, { recursive: true })
  const base = slug(clean)
  if (!base) throw new Error('O nome precisa conter letras ou números.')
  const existing = await readdir(directory)
  let id = base
  let suffix = 2
  while (existing.includes(id)) id = `${base}-${suffix++}`
  await mkdir(join(directory, id))
  const theme: ArtTheme = { id, name: clean, pages: [] }
  await saveTheme(theme)
  return theme
}

export async function deleteArtTheme(id: string): Promise<void> {
  const theme = (await listArtThemes()).find((item) => item.id === id)
  if (!theme) throw new Error('Tema não encontrado neste computador.')
  await shell.trashItem(await themePath(id))
}

export async function importArtTheme(): Promise<ArtTheme | null> {
  const picked = await pickPdfs()
  if (!picked) return null
  const name = basename(join(picked[0], '..')) || 'Novo tema'
  return addArtPdfs(await createArtTheme(name), picked)
}

async function pickPdfs(): Promise<string[] | null> {
  const picked = await dialog.showOpenDialog({
    title: 'Selecionar as artes PDF do tema',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections']
  })
  return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths
}

export async function importArtPdfs(id: string): Promise<ArtTheme | null> {
  const theme = (await listArtThemes()).find((item) => item.id === id)
  if (!theme) throw new Error('Tema não encontrado.')
  const picked = await pickPdfs()
  return picked ? addArtPdfs(theme, picked) : null
}

async function addArtPdfs(theme: ArtTheme, paths: string[]): Promise<ArtTheme> {
  const folder = await themePath(theme.id)
  const pages = [...theme.pages]
  if (pages.length + paths.length > 20) throw new Error('O tema aceita até 20 artes.')
  for (const source of paths) {
    if (extname(source).toLowerCase() !== '.pdf') throw new Error('Selecione apenas arquivos PDF.')
    const bytes = await readFile(source)
    const pdf = await PDFDocument.load(bytes)
    if (pdf.getPageCount() !== 1) throw new Error(`${basename(source)} precisa ter uma página A4.`)
    const { width, height } = pdf.getPage(0).getSize()
    if (Math.abs(width - 595.3) > 5 || Math.abs(height - 841.9) > 5) throw new Error(`${basename(source)} precisa estar em A4.`)
    const file = `${pages.length + 1}.pdf`
    await copyFile(source, join(folder, file))
    pages.push({ file, label: basename(source, extname(source)), fields: [] })
  }
  const updated = { ...theme, pages }
  await saveTheme(updated)
  return updated
}

export async function loadArtPdf(id: string, file: string): Promise<Uint8Array> {
  const theme = (await listArtThemes()).find((item) => item.id === id)
  if (!theme?.pages.some((page) => page.file === file)) throw new Error('Arte não encontrada.')
  return readFile(join(await themePath(id), file))
}

export async function loadArtFont(id: string): Promise<Uint8Array | null> {
  const theme = (await listArtThemes()).find((item) => item.id === id)
  if (!theme) throw new Error('Tema não encontrado.')
  return theme.fontFile ? readFile(join(await themePath(id), theme.fontFile)) : null
}

export async function importArtFont(id: string): Promise<ArtTheme | null> {
  const theme = (await listArtThemes()).find((item) => item.id === id)
  if (!theme) throw new Error('Tema não encontrado.')
  const picked = await dialog.showOpenDialog({
    title: 'Selecionar a fonte do tema',
    filters: [{ name: 'Fonte', extensions: ['ttf', 'otf'] }],
    properties: ['openFile']
  })
  if (picked.canceled || picked.filePaths.length === 0) return null
  const source = picked.filePaths[0]
  const extension = extname(source).toLowerCase()
  if (extension !== '.ttf' && extension !== '.otf') throw new Error('Selecione uma fonte TTF ou OTF.')
  const bytes = await readFile(source)
  const sample = await PDFDocument.create()
  sample.registerFontkit(fontkit)
  await sample.embedFont(bytes)
  const fontFile = `theme-font${extension}`
  await writeFile(join(await themePath(id), fontFile), bytes)
  const updated = { ...theme, fontFile, fontName: basename(source) }
  await saveTheme(updated)
  return updated
}

function validateField(field: ArtField): void {
  if (!['name', 'age'].includes(field.kind) || !Number.isFinite(field.x) || !Number.isFinite(field.y) || field.x < 0 || field.x > 1 || field.y < 0 || field.y > 1 || !Number.isFinite(field.fontSize) || field.fontSize < 4 || field.fontSize > 100 || !Number.isInteger(field.rotation) || field.rotation < 0 || field.rotation >= 360 || !/^#[0-9a-fA-F]{6}$/.test(field.color)) {
    throw new Error('Posição ou estilo de texto inválido.')
  }
  if (field.boxWidthMm !== undefined || field.boxHeightMm !== undefined) {
    if (!Number.isFinite(field.boxWidthMm) || !Number.isFinite(field.boxHeightMm) || (field.boxWidthMm ?? 0) < 1 || (field.boxWidthMm ?? 0) > 210 || (field.boxHeightMm ?? 0) < 1 || (field.boxHeightMm ?? 0) > 297 || !['left', 'center', 'right'].includes(field.alignX ?? 'center') || !['top', 'center', 'bottom'].includes(field.alignY ?? 'center')) {
      throw new Error('Área ou alinhamento de texto inválido.')
    }
  }
  const shadow = field.shadow
  const outline = field.outline
  if (field.embolden !== undefined && (!Number.isFinite(field.embolden) || field.embolden < 0 || field.embolden > 3)) {
    throw new Error('Espessura do texto inválida.')
  }
  if (outline && (!/^#[0-9a-fA-F]{6}$/.test(outline.color) || !Number.isFinite(outline.width) || outline.width < 0.25 || outline.width > 5)) {
    throw new Error('Configuração de contorno inválida.')
  }
  if (shadow && (!/^#[0-9a-fA-F]{6}$/.test(shadow.color) || !Number.isFinite(shadow.offsetX) || Math.abs(shadow.offsetX) > 20 || !Number.isFinite(shadow.offsetY) || Math.abs(shadow.offsetY) > 20 || !Number.isFinite(shadow.opacity) || shadow.opacity < 0 || shadow.opacity > 1 || !Number.isFinite(shadow.size ?? 0) || (shadow.size ?? 0) < 0 || (shadow.size ?? 0) > 5)) {
    throw new Error('Configuração de sombra inválida.')
  }
}

function pdfColor(hexColor: string): ReturnType<typeof rgb> {
  const hex = hexColor.slice(1)
  return rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255)
}

export async function updateArtTheme(input: ArtTheme): Promise<ArtTheme> {
  const current = (await listArtThemes()).find((item) => item.id === input.id)
  if (!current) throw new Error('Tema não encontrado.')
  if (!input.name.trim() || input.name.length > 100 || input.pages.length !== current.pages.length) throw new Error('Dados do tema inválidos.')
  for (const [index, page] of input.pages.entries()) {
    if (page.file !== current.pages[index].file || page.label !== current.pages[index].label || page.fields.length > 30) throw new Error('Dados da arte inválidos.')
    for (const field of page.fields) validateField(field)
  }
  const theme = { id: current.id, name: input.name.trim(), legacyId: current.legacyId, fontFile: current.fontFile, fontName: current.fontName, pages: input.pages }
  await saveTheme(theme)
  return theme
}

export async function renderArtDocument(theme: ArtTheme, directory: string, name: string, age: string): Promise<Uint8Array> {
  const usesName = theme.pages.some((page) => page.fields.some((field) => field.kind === 'name'))
  const usesAge = theme.pages.some((page) => page.fields.some((field) => field.kind === 'age'))
  if ((usesName && !name.trim()) || name.length > 80 || (usesAge && !age.trim()) || age.length > 20) {
    throw new Error(usesAge ? 'Informe nome e idade.' : 'Informe o nome.')
  }
  if (theme.pages.length === 0) throw new Error('O tema ainda não tem artes.')
  const output = await PDFDocument.create()
  if (theme.fontFile) output.registerFontkit(fontkit)
  const font = theme.fontFile
    ? await output.embedFont(await readFile(join(directory, theme.fontFile)))
    : await output.embedFont(StandardFonts.HelveticaBold)
  for (const art of theme.pages) {
    const source = await PDFDocument.load(await readFile(join(directory, art.file)))
    const [copied] = await output.copyPages(source, [0])
    const page = output.addPage(copied)
    const { width, height } = page.getSize()
    for (const field of art.fields) {
      validateField(field)
      const value = field.kind === 'name' ? name.trim() : age.trim()
      const ascent = font.heightAtSize(field.fontSize, { descender: false })
      const layout = layoutText(field, width, height, font.widthOfTextAtSize(value, field.fontSize), font.heightAtSize(field.fontSize), ascent,
        field.boxWidthMm && field.boxHeightMm ? (field.outline?.width ?? 0) + (field.embolden ?? 0) + 1 : 0)
      const origin = layout.origin
      if (field.shadow) {
        const samples = shadowSamples(field.shadow.offsetX, field.shadow.offsetY, field.shadow.size ?? 0)
        for (const sample of samples) {
          const shifted = shadowOrigin(origin, field.rotation, sample.x, sample.y)
          page.drawText(value, {
            x: shifted.x, y: shifted.y, size: layout.fontSize, font,
            rotate: degrees(-field.rotation), color: pdfColor(field.shadow.color), opacity: field.shadow.opacity
          })
        }
      }
      if (field.outline) {
        for (const sample of outlineSamples(field.outline.width + (field.embolden ?? 0))) {
          const shifted = shadowOrigin(origin, field.rotation, sample.x, sample.y)
          page.drawText(value, {
            x: shifted.x, y: shifted.y, size: layout.fontSize, font,
            rotate: degrees(-field.rotation), color: pdfColor(field.outline.color)
          })
        }
      }
      if (field.embolden) {
        for (const sample of outlineSamples(field.embolden)) {
          const shifted = shadowOrigin(origin, field.rotation, sample.x, sample.y)
          page.drawText(value, {
            x: shifted.x, y: shifted.y, size: layout.fontSize, font,
            rotate: degrees(-field.rotation), color: pdfColor(field.color)
          })
        }
      }
      page.drawText(value, {
        x: origin.x, y: origin.y, size: layout.fontSize, font,
        rotate: degrees(-field.rotation), color: pdfColor(field.color)
      })
    }
  }
  return output.save()
}

export async function generateArtPdf(id: string, name: string, age: string): Promise<string> {
  const theme = (await listArtThemes()).find((item) => item.id === id)
  if (!theme) throw new Error('Tema não encontrado.')
  const resultPdf = await renderArtDocument(theme, await themePath(id), name, age)
  const resultDir = join(app.getPath('documents'), 'CRM Seller', 'Artes')
  await mkdir(resultDir, { recursive: true })
  const safeName = name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 50)
  const result = join(resultDir, `${theme.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '')} - ${safeName} - ${Date.now()}.pdf`)
  await writeFile(result, resultPdf)
  const error = await shell.openPath(result)
  if (error) throw new Error(error)
  return result
}

async function orderArtInfo(orderSn: string): Promise<{ folderPath: string | null; childName: string | null; keys: string[] }> {
  if (!orderSn.trim() || orderSn.length > 100) throw new Error('Pedido inválido.')
  const [orders, products] = await getAsyncDb().queryBatch([
    { sql: 'SELECT folder_path, child_name FROM orders WHERE order_sn = ?', parameters: [orderSn] },
    { sql: `SELECT DISTINCT p.template_key FROM order_items i
      JOIN products p ON p.item_id = i.item_id
      WHERE i.order_sn = ? AND p.template_key IS NOT NULL`, parameters: [orderSn] }
  ])
  const row = orders[0] as { folder_path: string | null; child_name: string | null } | undefined
  if (!row) throw new Error('Pedido não encontrado.')
  const keys = (products as { template_key: string }[]).map((product) => product.template_key)
  return { folderPath: row.folder_path, childName: row.child_name, keys }
}

async function orderArtFolder(orderSn: string, info: Awaited<ReturnType<typeof orderArtInfo>>): Promise<string> {
  if (info.folderPath && existsSync(info.folderPath)) return info.folderPath
  const created = await createOrderFolder(orderSn)
  if (!created.ok || !created.path) throw new Error(created.error ?? 'Não foi possível criar a pasta do pedido.')
  return created.path
}

export async function loadOrderArt(orderSn: string): Promise<{ themes: ArtTheme[]; name: string }> {
  const info = await orderArtInfo(orderSn)
  if (info.keys.length === 0) return { themes: [], name: info.childName ?? '' }
  const folder = await orderArtFolder(orderSn, info)
  const templateRoot = await root()
  const themes: ArtTheme[] = []
  for (const key of info.keys) {
    if (!validId(key)) throw new Error('Vínculo de tema inválido.')
    const source = join(templateRoot, key)
    const target = join(folder, 'Artes', key)
    if (!existsSync(target)) {
      if (!existsSync(source)) throw new Error(`O tema "${key}" não está disponível neste computador.`)
      await mkdir(join(folder, 'Artes'), { recursive: true })
      await cp(source, target, { recursive: true })
    }
    const theme = JSON.parse(await readFile(join(target, 'theme.json'), 'utf8')) as ArtTheme
    if (theme.id !== key || !Array.isArray(theme.pages)) throw new Error(`Configuração do tema "${key}" inválida.`)
    orderFolderCache.set(`${orderSn}:${key}`, target)
    themes.push({ ...theme, pages: theme.pages.map((page) => ({ ...page, label: page.label || page.file })),
      personalization: theme.personalization ?? { name: info.childName ?? '', age: '' } })
  }
  return { themes, name: info.childName ?? '' }
}

async function orderThemeFolder(orderSn: string, key: string): Promise<string> {
  const cached = orderFolderCache.get(`${orderSn}:${key}`)
  if (cached && existsSync(cached)) return cached
  const info = await orderArtInfo(orderSn)
  if (!validId(key) || !info.keys.includes(key)) throw new Error('Tema não vinculado a este pedido.')
  const folder = await orderArtFolder(orderSn, info)
  const target = join(folder, 'Artes', key)
  if (!existsSync(target)) throw new Error('Abra o editor deste pedido para preparar a arte.')
  orderFolderCache.set(`${orderSn}:${key}`, target)
  return target
}

export async function loadOrderArtPdf(orderSn: string, key: string, file: string): Promise<Uint8Array> {
  const folder = await orderThemeFolder(orderSn, key)
  const theme = JSON.parse(await readFile(join(folder, 'theme.json'), 'utf8')) as ArtTheme
  if (!theme.pages.some((page) => page.file === file)) throw new Error('Arte não encontrada neste pedido.')
  return readFile(join(folder, file))
}

export async function loadOrderArtFont(orderSn: string, key: string): Promise<Uint8Array | null> {
  const folder = await orderThemeFolder(orderSn, key)
  const theme = JSON.parse(await readFile(join(folder, 'theme.json'), 'utf8')) as ArtTheme
  return theme.fontFile ? readFile(join(folder, theme.fontFile)) : null
}

export async function saveOrderArt(orderSn: string, input: ArtTheme, name: string, age: string): Promise<ArtTheme> {
  const folder = await orderThemeFolder(orderSn, input.id)
  const current = JSON.parse(await readFile(join(folder, 'theme.json'), 'utf8')) as ArtTheme
  if (input.pages.length !== current.pages.length || name.length > 80 || age.length > 20) throw new Error('Dados da personalização inválidos.')
  for (const [index, page] of input.pages.entries()) {
    if (page.file !== current.pages[index].file || page.fields.length > 30) throw new Error('Dados da arte inválidos.')
    page.fields.forEach(validateField)
  }
  const updated: ArtTheme = { ...current, pages: input.pages, personalization: { name: name.trim(), age: age.trim() } }
  const temp = join(folder, `order-theme-${randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify(updated), 'utf8')
  await rename(temp, join(folder, 'theme.json'))
  return updated
}

export async function generateOrderArtPdf(orderSn: string, key: string): Promise<string> {
  const folder = await orderThemeFolder(orderSn, key)
  const theme = JSON.parse(await readFile(join(folder, 'theme.json'), 'utf8')) as ArtTheme
  if (!theme.personalization) throw new Error('Salve a personalização antes de gerar o PDF.')
  const bytes = await renderArtDocument(theme, folder, theme.personalization.name, theme.personalization.age)
  const result = join(folder, `personalizado-${Date.now()}.pdf`)
  await writeFile(result, bytes)
  await markOrderArtGenerated(orderSn, key)
  const error = await shell.openPath(result)
  if (error) throw new Error(error)
  return result
}

export async function openLatestOrderArtPdf(orderSn: string, key: string): Promise<string> {
  const folder = await orderThemeFolder(orderSn, key)
  const files = (await readdir(folder)).filter((file) => /^personalizado-\d+\.pdf$/.test(file))
  files.sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))
  if (!files[0]) throw new Error('Gere a arte deste pedido antes de imprimir.')
  const file = join(folder, files[0])
  const error = await shell.openPath(file)
  if (error) throw new Error(error)
  return file
}

export async function importOrderArtFont(orderSn: string, key: string): Promise<ArtTheme | null> {
  const folder = await orderThemeFolder(orderSn, key)
  const picked = await dialog.showOpenDialog({
    title: 'Selecionar a fonte apenas para este pedido',
    filters: [{ name: 'Fonte', extensions: ['ttf', 'otf'] }],
    properties: ['openFile']
  })
  if (picked.canceled || picked.filePaths.length === 0) return null
  const source = picked.filePaths[0]
  const extension = extname(source).toLowerCase()
  if (extension !== '.ttf' && extension !== '.otf') throw new Error('Selecione uma fonte TTF ou OTF.')
  const bytes = await readFile(source)
  const sample = await PDFDocument.create()
  sample.registerFontkit(fontkit)
  await sample.embedFont(bytes)
  const current = JSON.parse(await readFile(join(folder, 'theme.json'), 'utf8')) as ArtTheme
  const fontFile = `order-font${extension}`
  await writeFile(join(folder, fontFile), bytes)
  const updated = { ...current, fontFile, fontName: basename(source) }
  const temp = join(folder, `order-theme-${randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify(updated), 'utf8')
  await rename(temp, join(folder, 'theme.json'))
  return updated
}
