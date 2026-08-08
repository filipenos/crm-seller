import { BrowserWindow, session as electronSession } from 'electron'
import { getSettings } from '../settings'

export const SHOPEE_PARTITION = 'persist:shopee'

/** Para onde o Seller Center joga o usuário quando a sessão morre. */
const LOGIN_URL_PATTERN = /accounts\.shopee\.[^/]+|\/seller\/login|\/buyer\/login/i

let hiddenWindow: BrowserWindow | null = null
let loginWindow: BrowserWindow | null = null

/**
 * Sessão expirada. Merece um tipo próprio porque o sintoma é enganoso: a
 * navegação "funciona" (redireciona para o login) e todo endpoint parece não
 * existir, o que faz qualquer diagnóstico concluir a coisa errada.
 */
export class ShopeeSessionExpiredError extends Error {
  constructor(detail?: string) {
    super(
      'Sessão da Shopee expirada — o Seller Center redirecionou para o login.' +
        ' Abra Configurações → Conectar e entre de novo.' +
        (detail ? ` (${detail})` : '')
    )
    this.name = 'ShopeeSessionExpiredError'
  }
}

/**
 * Erro devolvido pela própria Shopee (código + mensagem da API), em oposição a
 * uma falha nossa de parsing. As APIs internas quase sempre respondem HTTP 200
 * com `code != 0` no corpo — sem olhar o envelope, um erro de sessão vira
 * "resposta vazia" e o diagnóstico fica impossível.
 */
export class ShopeeApiError extends Error {
  readonly path: string
  readonly httpStatus: number
  readonly code: number | null

  constructor(opts: { path: string; httpStatus: number; code?: number | null; message: string }) {
    const detail = [
      opts.httpStatus > 0 ? `HTTP ${opts.httpStatus}` : null,
      opts.code !== null && opts.code !== undefined ? `code ${opts.code}` : null
    ]
      .filter(Boolean)
      .join(', ')
    super(detail ? `${opts.message} (${detail})` : opts.message)
    this.name = 'ShopeeApiError'
    this.path = opts.path
    this.httpStatus = opts.httpStatus
    this.code = opts.code ?? null
  }

  /** Sessão expirada ou sem permissão — o usuário precisa logar de novo. */
  get isAuthError(): boolean {
    if (this.httpStatus === 401 || this.httpStatus === 403) return true
    return /unauthor|not.?log|need.?login|login.?required|forbidden|session/i.test(this.message)
  }
}

/** Chaves que a Shopee usa para o código de retorno no envelope da resposta. */
const ENVELOPE_CODE_KEYS = ['code', 'error', 'err_code', 'errcode', 'retcode']
const ENVELOPE_MESSAGE_KEYS = [
  'message',
  'error_msg',
  'err_msg',
  'errmsg',
  'msg',
  'user_message',
  'debug_msg',
  'error_message'
]

function readEnvelope(json: unknown): {
  code: number | null
  message: string | null
  hasData: boolean
} {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { code: null, message: null, hasData: false }
  }
  const obj = json as Record<string, unknown>
  let code: number | null = null
  for (const key of ENVELOPE_CODE_KEYS) {
    const v = obj[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      code = v
      break
    }
    if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) {
      code = Number(v)
      break
    }
  }
  let message: string | null = null
  for (const key of ENVELOPE_MESSAGE_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim() !== '') {
      message = v.trim()
      break
    }
  }
  const data = obj.data
  const hasData = data !== undefined && data !== null
  return { code, message, hasData }
}

/** Resume um corpo não-JSON para caber numa mensagem de erro. */
function summarizeBody(text: string | null): string {
  const body = (text ?? '').trim()
  if (body === '') return 'resposta vazia'
  if (body.startsWith('<')) return 'resposta em HTML (provavelmente a página de login)'
  return body.slice(0, 300)
}

export function sellerBaseUrl(): string {
  return `https://seller.${getSettings().shopeeBaseDomain}`
}

/**
 * Abre a janela de login do Seller Center para o usuário autenticar manualmente.
 * A sessão (cookies) fica persistida na partition dedicada.
 */
export async function openLoginWindow(): Promise<void> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return
  }
  loginWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Login Shopee — feche esta janela após entrar no Seller Center',
    webPreferences: {
      partition: SHOPEE_PARTITION,
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  loginWindow.on('closed', () => {
    loginWindow = null
    // Recarrega a janela oculta para herdar a sessão nova.
    if (hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.destroy()
      hiddenWindow = null
    }
  })
  await loginWindow.loadURL(sellerBaseUrl())
}

async function ensureHiddenWindow(): Promise<BrowserWindow> {
  if (hiddenWindow && !hiddenWindow.isDestroyed()) {
    // A janela é reaproveitada entre chamadas, e o fetch usa caminho relativo:
    // se ela tiver derivado para outro host (redirecionamento de login), as
    // chamadas iriam para o domínio errado em vez de falhar.
    const current = hiddenWindow.webContents.getURL()
    if (current.startsWith(sellerBaseUrl())) return hiddenWindow
    if (LOGIN_URL_PATTERN.test(current)) throw new ShopeeSessionExpiredError(current)
    await hiddenWindow.loadURL(sellerBaseUrl())
    return hiddenWindow
  }
  hiddenWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: SHOPEE_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  await hiddenWindow.loadURL(sellerBaseUrl())
  if (LOGIN_URL_PATTERN.test(hiddenWindow.webContents.getURL())) {
    throw new ShopeeSessionExpiredError()
  }
  return hiddenWindow
}

export function destroyHiddenWindow(): void {
  if (hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.destroy()
  hiddenWindow = null
}

/**
 * Executa um fetch dentro do contexto da página logada do Seller Center.
 * Assim cookies, headers e origem ficam corretos sem replicar anti-CSRF.
 */
export async function pageFetchJson(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  const win = await ensureHiddenWindow()
  const script = `
    (async () => {
      try {
        const res = await fetch(${JSON.stringify(path)}, {
          method: ${JSON.stringify(init?.method ?? 'GET')},
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          ${init?.body !== undefined ? `body: ${JSON.stringify(JSON.stringify(init.body))},` : ''}
        })
        const text = await res.text()
        let json = null
        try { json = JSON.parse(text) } catch {}
        return { ok: res.ok, status: res.status, json, text: json ? null : text.slice(0, 2000) }
      } catch (err) {
        return { ok: false, status: 0, json: null, text: String(err) }
      }
    })()
  `
  const result = (await win.webContents.executeJavaScript(script, true)) as {
    ok: boolean
    status: number
    json: unknown
    text: string | null
  }
  const envelope = readEnvelope(result.json)

  if (!result.ok) {
    throw new ShopeeApiError({
      path,
      httpStatus: result.status,
      code: envelope.code,
      message: envelope.message ?? summarizeBody(result.text)
    })
  }
  // HTTP 200 com código de erro no corpo é o caso comum nas APIs internas.
  // Só tratamos como erro quando há mensagem ou quando não veio `data` junto —
  // alguns endpoints usam `code` com outro significado quando dão certo.
  if (envelope.code !== null && envelope.code !== 0) {
    if (envelope.message !== null || !envelope.hasData) {
      throw new ShopeeApiError({
        path,
        httpStatus: result.status,
        code: envelope.code,
        message: envelope.message ?? 'a Shopee recusou a chamada'
      })
    }
  }
  return result.json
}

/** Busca um recurso binário (ex.: PDF de etiqueta) e retorna como Buffer. */
export async function pageFetchBinary(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<Buffer> {
  const win = await ensureHiddenWindow()
  const script = `
    (async () => {
      try {
        const res = await fetch(${JSON.stringify(path)}, {
          method: ${JSON.stringify(init?.method ?? 'GET')},
          credentials: 'include',
          ${init?.body !== undefined ? `headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(init.body))},` : ''}
        })
        if (!res.ok) {
          const text = await res.text()
          return { ok: false, status: res.status, base64: null, contentType: res.headers.get('content-type'), text: text.slice(0, 300) }
        }
        const buf = await res.arrayBuffer()
        let binary = ''
        const bytes = new Uint8Array(buf)
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        }
        return { ok: true, status: res.status, base64: btoa(binary), contentType: res.headers.get('content-type'), text: null }
      } catch (err) {
        return { ok: false, status: 0, base64: null, contentType: null, text: String(err) }
      }
    })()
  `
  const result = (await win.webContents.executeJavaScript(script, true)) as {
    ok: boolean
    status: number
    base64: string | null
    contentType: string | null
    text: string | null
  }
  if (!result.ok || !result.base64) {
    throw new ShopeeApiError({
      path,
      httpStatus: result.status,
      message: `download falhou [${result.contentType ?? 'sem content-type'}]: ${summarizeBody(result.text)}`
    })
  }
  return Buffer.from(result.base64, 'base64')
}

/** Busca o texto cru de um endpoint (para diagnóstico). */
export async function pageFetchText(path: string): Promise<{ status: number; text: string }> {
  const win = await ensureHiddenWindow()
  const script = `
    (async () => {
      try {
        const res = await fetch(${JSON.stringify(path)}, { credentials: 'include' })
        const text = await res.text()
        return { status: res.status, text: text.slice(0, 60000) }
      } catch (err) {
        return { status: 0, text: String(err) }
      }
    })()
  `
  return (await win.webContents.executeJavaScript(script, true)) as {
    status: number
    text: string
  }
}

/**
 * Lê os links internos que o portal expõe no menu.
 *
 * Vale uma navegação só e substitui a adivinhação de caminho de página — que
 * custava um carregamento de SPA por palpite errado. Se o menu não render,
 * devolve lista vazia e o chamador cai nos candidatos fixos.
 */
export async function collectPortalLinks(waitMs = 6000): Promise<string[]> {
  const win = await ensureHiddenWindow()
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  const links = (await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('a[href]'), (a) => a.getAttribute('href'))`,
    true
  )) as (string | null)[]
  const unique = new Set<string>()
  for (const href of links) {
    if (!href) continue
    // Só caminhos internos do portal; externos e âncoras não interessam.
    const path = href.startsWith('http') ? new URL(href).pathname : href.split('?')[0]
    if (path.startsWith('/portal/') || path.startsWith('/webchat')) unique.add(path)
  }
  return [...unique]
}

export interface CapturedRequest {
  url: string
  method: string
  status: number
  body: string | null
}

/**
 * Abre uma página do Seller Center na janela oculta e captura TODAS as
 * requisições da sessão via webRequest (pega XHR, fetch, POST com corpo,
 * iframes e service workers). É assim que descobrimos os endpoints reais.
 */
export async function capturePageRequests(
  path: string,
  waitMs = 12000
): Promise<CapturedRequest[]> {
  const ses = electronSession.fromPartition(SHOPEE_PARTITION)
  const bodies = new Map<string, string>()
  const captured: CapturedRequest[] = []
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (details.uploadData?.length) {
      try {
        const raw = Buffer.concat(
          details.uploadData.map((u) => u.bytes).filter((b): b is Buffer => Boolean(b))
        )
        bodies.set(String(details.id), raw.toString('utf8').slice(0, 8000))
      } catch {
        // corpo não textual — ignora
      }
    }
    callback({})
  })
  ses.webRequest.onCompleted((details) => {
    captured.push({
      url: details.url,
      method: details.method,
      status: details.statusCode,
      body: bodies.get(String(details.id)) ?? null
    })
  })
  try {
    const win = await ensureHiddenWindow()
    try {
      await win.loadURL(sellerBaseUrl() + path)
    } catch (err) {
      // Uma navegação abortada deixa a janela num estado em que TODAS as
      // seguintes falham com ERR_FAILED. Destruir força a próxima captura a
      // começar numa janela limpa, em vez de derrubar o diagnóstico inteiro.
      destroyHiddenWindow()
      throw err
    }
    // Redirecionou para o login: sem isto, o relatório conclui "essa página
    // não existe" para todas as páginas, que é exatamente a leitura errada.
    if (LOGIN_URL_PATTERN.test(win.webContents.getURL())) {
      throw new ShopeeSessionExpiredError(path)
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  } finally {
    ses.webRequest.onBeforeRequest(null)
    ses.webRequest.onCompleted(null)
  }
  return captured.filter(
    (r) => !/\.(js|css|png|jpe?g|svg|woff2?|ico|gif|webp|mp3)(\?|$)/.test(r.url)
  )
}

/** Replica uma requisição capturada (mesma URL, método e corpo) e retorna o texto. */
export async function replayRequest(req: {
  url: string
  method: string
  body: string | null
}): Promise<{ status: number; text: string }> {
  const win = await ensureHiddenWindow()
  const script = `
    (async () => {
      try {
        const res = await fetch(${JSON.stringify(req.url)}, {
          method: ${JSON.stringify(req.method)},
          credentials: 'include',
          ${req.body ? `headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(req.body)},` : ''}
        })
        const text = await res.text()
        return { status: res.status, text: text.slice(0, 80000) }
      } catch (err) {
        return { status: 0, text: String(err) }
      }
    })()
  `
  return (await win.webContents.executeJavaScript(script, true)) as {
    status: number
    text: string
  }
}

const SESSION_COOKIES = ['SPC_SC_TK', 'SPC_SC_SESSION', 'SPC_ST']

/**
 * Conectado = existe cookie de sessão do Seller Center **ainda válido**.
 *
 * Só a presença não basta: cookie vencido continua no disco e fazia o app
 * anunciar "conectado" enquanto toda navegação era redirecionada para o login.
 * Isso não pega sessão revogada do lado da Shopee — para essa, quem avisa é o
 * `ShopeeSessionExpiredError` na primeira navegação.
 */
export async function isConnected(): Promise<boolean> {
  const ses = electronSession.fromPartition(SHOPEE_PARTITION)
  const cookies = await ses.cookies.get({})
  const nowSeconds = Date.now() / 1000
  const connected = cookies.some(
    (c) =>
      SESSION_COOKIES.includes(c.name) &&
      c.value.length > 0 &&
      // Sem expirationDate = cookie de sessão, vale enquanto a partition viver.
      (c.expirationDate === undefined || c.expirationDate > nowSeconds)
  )
  if (!connected) {
    console.log(
      '[shopee] não conectado. Cookies presentes:',
      cookies.map((c) => c.name).join(', ') || '(nenhum)'
    )
  }
  return connected
}

export async function disconnect(): Promise<void> {
  destroyHiddenWindow()
  const ses = electronSession.fromPartition(SHOPEE_PARTITION)
  await ses.clearStorageData()
}
