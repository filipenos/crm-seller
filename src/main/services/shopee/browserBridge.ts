import { randomBytes, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { BrowserWindow, session as electronSession } from 'electron'
import { bindCurrentShopeeAccountAsync } from './accountBinding'
import { chromeShopeePartition, getShopeeAuthMode, setChromeUserAgent } from './authMode'
import { destroyHiddenWindow } from './session'

export const BROWSER_BRIDGE_PORT = 17384
// ID fixado pela chave pública no manifest da extensão local.
const EXTENSION_ORIGIN = 'chrome-extension://dpfmppjjfdhnpggigjkjobcbbhhonkai'

interface ChromeCookie {
  name: string
  value: string
  domain: string
  path: string
  hostOnly: boolean
  secure: boolean
  httpOnly: boolean
  sameSite: string
  expirationDate?: number
}

interface PendingRequest {
  id: string
  resolve: (shopId: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  processing: boolean
}

let server: Server | null = null
let pending: PendingRequest | null = null
let lastError: string | null = null

export function browserBridgeStatus(): { mode: 'app' | 'chrome'; pending: boolean; error: string | null } {
  return { mode: getShopeeAuthMode(), pending: Boolean(pending), error: lastError }
}

function notify(): void {
  const status = browserBridgeStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('shopee:browser-status', status)
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': EXTENSION_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-CRM-Bridge, X-CRM-Request-Id',
    Vary: 'Origin'
  })
  res.end(JSON.stringify(body))
}

function validCookie(value: unknown): value is ChromeCookie {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const cookie = value as Partial<ChromeCookie>
  return typeof cookie.name === 'string' && /^[\w.-]{1,200}$/.test(cookie.name) &&
    typeof cookie.value === 'string' && cookie.value.length <= 8192 &&
    typeof cookie.domain === 'string' && /(^|\.)shopee\.com\.br$/i.test(cookie.domain) &&
    typeof cookie.path === 'string' && cookie.path.startsWith('/') && cookie.path.length <= 200 &&
    typeof cookie.hostOnly === 'boolean' && typeof cookie.secure === 'boolean' &&
    typeof cookie.httpOnly === 'boolean' && typeof cookie.sameSite === 'string' &&
    ['no_restriction', 'lax', 'strict', 'unspecified'].includes(cookie.sameSite) &&
    (cookie.expirationDate === undefined || (typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)))
}

async function receiveSession(body: unknown): Promise<string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Sessão inválida.')
  const input = body as { cookies?: unknown; userAgent?: unknown }
  if (!Array.isArray(input.cookies) || input.cookies.length < 1 || input.cookies.length > 200 ||
      !input.cookies.every(validCookie) || typeof input.userAgent !== 'string') {
    throw new Error('Sessão do Chrome inválida.')
  }
  const cookies = input.cookies as ChromeCookie[]
  if (!cookies.some((cookie) => ['SPC_SC_TK', 'SPC_SC_SESSION', 'SPC_ST'].includes(cookie.name) && cookie.value)) {
    throw new Error('Entre na Shopee no Chrome e tente novamente.')
  }
  if (!cookies.some((cookie) => cookie.name === 'SPC_CDS' && cookie.value)) {
    throw new Error('A sessão do Seller Center está incompleta no Chrome. Atualize a página da Shopee e tente novamente.')
  }

  const session = electronSession.fromPartition(chromeShopeePartition())
  await session.clearStorageData({ storages: ['cookies'] })
  for (const cookie of cookies) {
    const hostname = cookie.domain.replace(/^\./, '')
    await session.cookies.set({
      url: `https://${hostname}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.hostOnly ? undefined : cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite as 'no_restriction' | 'lax' | 'strict' | 'unspecified',
      expirationDate: cookie.expirationDate
    })
  }
  setChromeUserAgent(input.userAgent)
  destroyHiddenWindow()
  // A própria rotina atual confere a identidade da loja e impede mistura no Turso.
  return bindCurrentShopeeAccountAsync()
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 200_000) throw new Error('Sessão grande demais.')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Sessão inválida.') }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.headers.origin && req.headers.origin !== EXTENSION_ORIGIN) {
    respond(res, 403, { error: 'Extensão não autorizada.' })
    return
  }
  if (req.method === 'OPTIONS') { respond(res, 204, {}) ; return }
  if (req.headers['x-crm-bridge'] !== 'shopee-session-v1') {
    respond(res, 403, { error: 'Extensão não autorizada.' })
    return
  }
  if (req.method === 'GET' && req.url === '/status') {
    respond(res, 200, { requestId: getShopeeAuthMode() === 'chrome' && pending && !pending.processing ? pending.id : null })
    return
  }
  if (req.method !== 'POST' || req.url !== '/session' || !pending || pending.processing || getShopeeAuthMode() !== 'chrome') {
    respond(res, 404, { error: 'Nenhuma sessão foi solicitada.' })
    return
  }
  const id = req.headers['x-crm-request-id']
  const sent = typeof id === 'string' ? Buffer.from(id) : Buffer.alloc(0)
  const expected = Buffer.from(pending.id)
  if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
    respond(res, 403, { error: 'Solicitação inválida.' })
    return
  }
  const current = pending
  current.processing = true
  clearTimeout(current.timer)
  try {
    const shopId = await receiveSession(await readBody(req))
    pending = null
    lastError = null
    current.resolve(shopId)
    respond(res, 200, { connected: true, shopId })
  } catch (error) {
    pending = null
    lastError = error instanceof Error ? error.message : 'Falha ao usar a sessão do Chrome.'
    current.reject(new Error(lastError))
    respond(res, 400, { error: lastError })
  }
  notify()
}

export async function startBrowserBridge(): Promise<void> {
  if (server) return
  const candidate = createServer((req, res) => {
    void handle(req, res).catch(() => respond(res, 500, { error: 'Falha na comunicação local.' }))
  })
  await new Promise<void>((resolve, reject) => {
    candidate.once('error', reject)
    candidate.listen(BROWSER_BRIDGE_PORT, '127.0.0.1', () => {
      candidate.off('error', reject)
      resolve()
    })
  })
  server = candidate
}

export function stopBrowserBridge(): void {
  if (!pending?.processing) cancelBrowserSession('Aplicativo fechado.')
  server?.close()
  server = null
}

export function cancelBrowserSession(reason = 'Conexão com o Chrome cancelada.'): void {
  if (!pending) return
  if (pending.processing) throw new Error('Aguarde a validação da sessão do Chrome e tente desconectar novamente.')
  clearTimeout(pending.timer)
  pending.reject(new Error(reason))
  pending = null
  notify()
}

export function requestBrowserSession(): Promise<string> {
  if (getShopeeAuthMode() !== 'chrome') return Promise.reject(new Error('Selecione o login pelo Chrome.'))
  if (!server) return Promise.reject(new Error('Ponte com o Chrome indisponível. Reinicie o aplicativo.'))
  if (pending) return Promise.reject(new Error('Aguardando a extensão do Chrome.'))
  lastError = null
  const result = new Promise<string>((resolve, reject) => {
    const id = randomBytes(24).toString('hex')
    const timer = setTimeout(() => {
      pending = null
      lastError = 'O Chrome não respondeu. Abra o ícone da extensão CRM Seller no perfil onde você usa a Shopee e clique em Conectar ao aplicativo.'
      reject(new Error(lastError))
      notify()
    }, 120_000)
    pending = { id, resolve, reject, timer, processing: false }
  })
  notify()
  return result
}
