import { app } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDb } from '../../db'
import {
  capturePageRequests,
  collectPortalLinks,
  isConnected,
  replayRequest,
  ShopeeSessionExpiredError
} from './session'

/**
 * Diagnóstico: abre as páginas do Seller Center numa janela oculta, captura
 * todas as chamadas de API que elas fazem (com o corpo dos POSTs) e repete as
 * mais promissoras para guardar uma amostra da resposta.
 *
 * É o processo que descobriu os endpoints de pedidos; os endpoints de
 * avaliações, financeiro e rastreio ainda são candidatos adivinhados e é isto
 * que vai substituí-los pelos reais. Tudo é gravado em `userData/debug/`.
 */

export interface ProbeTarget {
  key: string
  label: string
  /** Páginas do Seller Center a abrir; várias porque o caminho muda entre versões. */
  pages: string[]
  /** Chamadas que interessam replicar para ver a resposta. */
  interesting: RegExp
  /** Como reconhecer a página certa no menu do portal, sem adivinhar caminho. */
  linkPattern: RegExp
}

/**
 * Orçamento de requisições. Estes endpoints são internos e não têm cota
 * publicada; cada página aberta é um SPA inteiro (dezenas de requisições).
 * Melhor um diagnóstico incompleto do que a conta marcada.
 */
const MAX_PAGE_LOADS = 8
const MAX_REPLAYS_PER_TARGET = 3
const PAUSE_BETWEEN_LOADS_MS = 2500

/** Nunca repetir chamadas que possam alterar algo na loja. */
const MUTATING = /update|create|delete|cancel|arrange|confirm|submit|set_|add_|remove|upload|edit|reply|send/i

/** Só requisições de API (o resto é html/asset e não ajuda). */
const API_URL = /\/(api|webchat)\//

function sampleOrder(): { orderSn: string; orderId: string } | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT order_sn, shopee_order_id FROM orders
          WHERE shopee_order_id IS NOT NULL
          ORDER BY (tracking_number IS NOT NULL) DESC, created_at_shopee DESC
          LIMIT 1`
      )
      .get() as { order_sn: string; shopee_order_id: string } | undefined
    if (!row) return null
    return { orderSn: row.order_sn, orderId: row.shopee_order_id }
  } catch {
    return null
  }
}

export function buildTargets(): ProbeTarget[] {
  const order = sampleOrder()
  return [
    {
      key: 'financeiro',
      label: 'Financeiro / carteira',
      pages: ['/portal/finance/income/transaction', '/portal/finance/my_balance'],
      interesting: /finance|wallet|transaction|income|escrow|payout|balance/i,
      linkPattern: /finance|wallet|income|balance|payout/i
    },
    {
      key: 'avaliacoes',
      label: 'Avaliações da loja',
      pages: ['/portal/settings/shop/rating', '/portal/customer-service/rating'],
      interesting: /rating|comment|review/i,
      linkPattern: /rating|review|comment/i
    },
    {
      key: 'rastreio',
      label: 'Rastreio logístico',
      pages: [...(order ? [`/portal/sale/order/${order.orderId}`] : []), '/portal/sale/shipment'],
      interesting: /logistic|tracking|shipment|trace|awb/i,
      linkPattern: /shipment|logistic|tracking/i
    },
    {
      key: 'ads',
      label: 'Anúncios (Shopee Ads) — gasto por campanha',
      pages: ['/portal/marketing/pas'],
      interesting: /ads|campaign|marketing|pas\/|acos|spend|budget/i,
      linkPattern: /marketing|ads|pas/i
    },
    {
      key: 'chat',
      label: 'Chat / conversas',
      pages: ['/webchat/conversations'],
      interesting: /webchat\/api/i,
      linkPattern: /webchat|chat/i
    },
    {
      key: 'produtos',
      label: 'Produtos / anúncios cadastrados (SKU para casar com o cadastro interno)',
      pages: ['/portal/product/list/all'],
      interesting: /product|item|sku|model/i,
      linkPattern: /product/i
    }
  ]
}

interface CapturedRow {
  url: string
  method: string
  status: number
  body: string | null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function stamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function buildSummary(
  targets: ProbeTarget[],
  captured: Record<string, Record<string, CapturedRow[]>>
): string {
  const lines: string[] = [
    '# Diagnóstico das APIs do Seller Center',
    '',
    `Gerado em ${new Date().toLocaleString('pt-BR')}.`,
    '',
    'Cada seção lista as chamadas de API que a página real fez. As marcadas com',
    '★ casam com o filtro do alvo — são as candidatas a virar endpoint no',
    '`client.ts`. O corpo dos POSTs está em `requests.json`, e a resposta das',
    'replicadas em `samples.json`.',
    ''
  ]
  for (const target of targets) {
    lines.push(`## ${target.label}`, '')
    const pages = captured[target.key] ?? {}
    for (const [page, rows] of Object.entries(pages)) {
      const apis = rows.filter((r) => API_URL.test(r.url))
      lines.push(`### \`${page}\` — ${apis.length} chamadas de API`, '')
      if (apis.length === 0) {
        lines.push('_Nenhuma — a página provavelmente não existe nesse caminho._', '')
        continue
      }
      const seen = new Set<string>()
      for (const row of apis) {
        const path = row.url.split('?')[0].replace(/^https?:\/\/[^/]+/, '')
        if (seen.has(`${row.method} ${path}`)) continue
        seen.add(`${row.method} ${path}`)
        const mark = target.interesting.test(row.url) ? '★' : '·'
        lines.push(`- ${mark} \`${row.method} ${path}\` → HTTP ${row.status}`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

let running = false

export async function probeShopeeApis(): Promise<string> {
  if (running) throw new Error('Diagnóstico já está rodando.')
  running = true
  try {
    if (!(await isConnected())) {
      throw new Error('Não conectado à Shopee. Faça login em Configurações antes de diagnosticar.')
    }
    const targets = buildTargets()
    const debugDir = join(app.getPath('userData'), 'debug', `probe-${stamp()}`)
    await mkdir(debugDir, { recursive: true })

    // 1. Descobre os caminhos reais no menu do portal (uma navegação só) em vez
    //    de gastar um carregamento de SPA por palpite de URL.
    let portalLinks: string[] = []
    try {
      portalLinks = await collectPortalLinks()
      console.log(`[probe] ${portalLinks.length} links encontrados no menu do portal`)
    } catch (err) {
      if (err instanceof ShopeeSessionExpiredError) throw err
      console.warn('[probe] não consegui ler o menu, usando candidatos fixos:', err)
    }
    await writeFile(join(debugDir, 'portal-links.json'), JSON.stringify(portalLinks, null, 2))

    // 2. Captura: o que cada página realmente chama. Para no primeiro acerto de
    //    cada alvo e respeita o orçamento global de navegações.
    const captured: Record<string, Record<string, CapturedRow[]>> = {}
    const skipped: string[] = []
    let loads = 0

    for (const target of targets) {
      captured[target.key] = {}
      const fromMenu = portalLinks.filter((l) => target.linkPattern.test(l))
      // Menu primeiro; candidatos fixos só como plano B. No máximo 2 tentativas.
      const pages = [...new Set([...fromMenu, ...target.pages])].slice(0, 2)

      for (const page of pages) {
        if (loads >= MAX_PAGE_LOADS) {
          skipped.push(`${target.key} → ${page} (orçamento de ${MAX_PAGE_LOADS} navegações esgotado)`)
          continue
        }
        if (loads > 0) await sleep(PAUSE_BETWEEN_LOADS_MS)
        loads++
        console.log(`[probe] (${loads}/${MAX_PAGE_LOADS}) ${target.key} → ${page}`)
        try {
          const rows = await capturePageRequests(page, 8000)
          captured[target.key][page] = rows
          // Achou o que interessa: não precisa abrir os outros candidatos.
          if (rows.some((r) => API_URL.test(r.url) && target.interesting.test(r.url))) {
            console.log(`[probe] ${target.key}: acertou em ${page}, pulando o resto`)
            break
          }
        } catch (err) {
          // Sessão morta afeta TODAS as páginas: seguir adiante só produziria
          // um relatório dizendo que nenhuma delas existe.
          if (err instanceof ShopeeSessionExpiredError) throw err
          captured[target.key][page] = [
            { url: `ERRO: ${String(err)}`, method: '-', status: -1, body: null }
          ]
        }
      }
    }
    if (skipped.length > 0) console.warn('[probe] não visitadas:', skipped.join(' | '))
    await writeFile(join(debugDir, 'requests.json'), JSON.stringify(captured, null, 2))

    // 2. Replay das chamadas interessantes (só leitura) para ver a resposta.
    const samples: Record<string, { request: unknown; status: number; text: string }> = {}
    for (const target of targets) {
      const seen = new Set<string>()
      const rows = Object.values(captured[target.key] ?? {})
        .flat()
        .filter((r) => API_URL.test(r.url) && target.interesting.test(r.url))
        .filter((r) => !MUTATING.test(r.url))
        .filter((r) => {
          const key = `${r.method} ${r.url.split('?')[0]}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .slice(0, MAX_REPLAYS_PER_TARGET)

      for (const row of rows) {
        const key = `${target.key} | ${row.method} ${row.url.split('?')[0]}`
        try {
          await sleep(400)
          const res = await replayRequest(row)
          samples[key] = {
            request: { url: row.url, body: row.body },
            status: res.status,
            text: res.text.slice(0, 20000)
          }
        } catch (err) {
          samples[key] = {
            request: { url: row.url, body: row.body },
            status: -1,
            text: String(err)
          }
        }
      }
    }
    await writeFile(join(debugDir, 'samples.json'), JSON.stringify(samples, null, 2))
    await writeFile(join(debugDir, 'RESUMO.md'), buildSummary(targets, captured))

    console.log(`[probe] diagnóstico gravado em ${debugDir}`)
    return debugDir
  } finally {
    running = false
  }
}
