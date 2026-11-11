import { timingSafeEqual } from 'node:crypto'

interface RequestInfo {
  url: string | undefined
  method: string | undefined
  host: string | undefined
  origin: string | undefined
  authorization: string | undefined
}

function sameToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Valida a entrada antes de entregar a requisição ao protocolo MCP. */
export function mcpAccessStatus(info: RequestInfo, options: {
  lan: boolean
  token?: string
  localPort: number
  lanPort: number
  addresses: string[]
}): 401 | 403 | 404 | null {
  const { lan, token, localPort, lanPort, addresses } = options
  if (info.url !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(info.method ?? '')) return 404
  const hosts = lan
    ? [...addresses.map((address) => `${address}:${lanPort}`), `localhost:${lanPort}`, `127.0.0.1:${lanPort}`]
    : [`localhost:${localPort}`, `127.0.0.1:${localPort}`]
  if (!info.host || !hosts.includes(info.host)) return 403
  if (info.origin && ![`http://${info.host}`, `https://${info.host}`].includes(info.origin)) return 403
  if (lan && (!token || !sameToken((info.authorization ?? '').replace(/^Bearer /, ''), token))) return 401
  return null
}
