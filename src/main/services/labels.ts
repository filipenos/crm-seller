import { BrowserWindow } from 'electron'
import { rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ActionResult, Order } from '@shared/types'
import { getOrder, setLabelPath } from './orders'
import { createOrderFolder } from './folders'
import { downloadShippingDocument } from './shopee/client'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function internalLabelHtml(order: Order): string {
  const items = order.items
    .map(
      (i) =>
        `<tr><td>${i.quantity}x</td><td>${escapeHtml(i.itemName)}${
          i.modelName ? `<br><small>${escapeHtml(i.modelName)}</small>` : ''
        }</td></tr>`
    )
    .join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: 100mm 150mm; margin: 5mm; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #000; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .box { border: 1.5px solid #000; border-radius: 4px; padding: 6px 8px; margin-bottom: 6px; }
  .big { font-size: 20px; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 4px; vertical-align: top; border-bottom: 1px solid #ccc; }
  small { color: #444; }
</style></head><body>
  <div class="box">
    <h1>Pedido ${escapeHtml(order.orderSn)}</h1>
    <div>Comprador: <b>${escapeHtml(order.buyerName ?? order.buyerUsername ?? '-')}</b></div>
    ${order.trackingNumber ? `<div>Rastreio: <b>${escapeHtml(order.trackingNumber)}</b></div>` : ''}
  </div>
  ${order.childName ? `<div class="box"><div>Personalização (nome):</div><div class="big">${escapeHtml(order.childName)}</div></div>` : ''}
  <div class="box"><table>${items}</table></div>
  ${order.note ? `<div class="box">Obs: ${escapeHtml(order.note)}</div>` : ''}
</body></html>`
}

async function generateInternalLabelPdf(order: Order): Promise<Buffer> {
  // Duas armadilhas já encontradas aqui, ambas com o mesmo sintoma inútil
  // ("Printing failed"): `offscreen: true` não imprime no Linux/Wayland, e
  // `data:` URL nem sempre é considerada carregada a tempo. Arquivo temporário
  // + janela oculta comum é o caminho que funciona nas três plataformas.
  const win = new BrowserWindow({ show: false, width: 400, height: 600 })
  const tmpFile = join(tmpdir(), `crm-seller-etiqueta-${order.orderSn}-${process.pid}.html`)
  try {
    await writeFile(tmpFile, internalLabelHtml(order), 'utf8')
    await win.loadFile(tmpFile)
    const data = await win.webContents.printToPDF({
      pageSize: { width: 100_000, height: 150_000 }, // microns → 100mm x 150mm
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    })
    return Buffer.from(data)
  } finally {
    win.destroy()
    await rm(tmpFile, { force: true }).catch(() => {})
  }
}

/**
 * Gera a etiqueta do pedido e salva na pasta dele.
 * Tenta baixar o documento de envio oficial da Shopee (AWB); se não
 * conseguir, gera uma etiqueta interna de produção (100x150mm).
 */
export async function generateLabel(orderSn: string): Promise<ActionResult> {
  const order = getOrder(orderSn)
  if (!order) return { ok: false, error: `Pedido ${orderSn} não encontrado` }

  // Garante que a pasta do pedido existe.
  let folderPath = order.folderPath
  if (!folderPath || !existsSync(folderPath)) {
    const created = await createOrderFolder(orderSn)
    if (!created.ok) return created
    folderPath = created.path!
  }

  let pdf: Buffer
  let source: string
  try {
    pdf = await downloadShippingDocument(order.orderSn, order.shopeeOrderId)
    source = 'shopee'
  } catch (shopeeError) {
    // O documento oficial ainda usa endpoints não confirmados. Registrar o
    // motivo é o que permite calibrá-los depois — engolir o erro faria a
    // etiqueta interna parecer uma escolha, e não um plano B.
    console.warn('[etiqueta] documento da Shopee indisponível:', shopeeError)
    try {
      pdf = await generateInternalLabelPdf(order)
      source = 'interna'
    } catch (internalError) {
      return {
        ok: false,
        error:
          `Falhou nos dois caminhos. Shopee: ${String(shopeeError instanceof Error ? shopeeError.message : shopeeError)}` +
          ` | etiqueta interna: ${String(internalError instanceof Error ? internalError.message : internalError)}`
      }
    }
  }

  try {
    const labelPath = join(folderPath, `etiqueta-${source}-${order.orderSn}.pdf`)
    await writeFile(labelPath, pdf)
    setLabelPath(orderSn, labelPath)
    return { ok: true, path: labelPath }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
