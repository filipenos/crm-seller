import { app } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDb } from '../../db'
import { capturePageRequests, isConnected, replayRequest } from './session'

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
}

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
      key: 'pedidos',
      label: 'Pedidos (referência — já calibrado)',
      pages: ['/portal/sale/order'],
      interesting: /search_order_list_index|get_order_list_card_list/i
    },
    {
      key: 'chat',
      label: 'Chat / conversas',
      pages: ['/webchat/conversations', '/portal/chat'],
      interesting: /webchat\/api/i
    },
    {
      key: 'avaliacoes',
      label: 'Avaliações da loja',
      pages: [
        '/portal/settings/shop/rating',
        '/portal/customer-service/rating',
        '/portal/sale/rating'
      ],
      interesting: /rating|comment|review/i
    },
    {
      key: 'financeiro',
      label: 'Financeiro / carteira',
      pages: [
        '/portal/finance/income/transaction',
        '/portal/finance/account/transaction',
        '/portal/finance/my_balance',
        '/portal/finance/wallet'
      ],
      interesting: /finance|wallet|transaction|income|escrow|payout|balance/i
    },
    {
      key: 'ads',
      label: 'Anúncios (Shopee Ads) — gasto por campanha',
      pages: [
        '/portal/marketing/pas',
        '/portal/marketing/pas/dashboard',
        '/portal/marketing/ads',
        '/portal/ads'
      ],
      interesting: /ads|campaign|marketing|pas\/|acos|spend|budget/i
    },
    {
      key: 'produtos',
      label: 'Produtos / anúncios cadastrados (SKU para casar com o cadastro interno)',
      pages: ['/portal/product/list/all', '/portal/product/list'],
      interesting: /product|item|sku|model/i
    },
    {
      key: 'rastreio',
      label: 'Rastreio logístico',
      pages: [
        ...(order ? [`/portal/sale/order/${order.orderId}`] : []),
        '/portal/sale/shipment'
      ],
      interesting: /logistic|tracking|shipment|trace|awb/i
    }
  ]
}

interface CapturedRow {
  url: string
  method: string
  status: number
  body: string | null
}

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

    // 1. Captura: o que cada página realmente chama.
    const captured: Record<string, Record<string, CapturedRow[]>> = {}
    for (const target of targets) {
      captured[target.key] = {}
      for (const page of target.pages) {
        console.log(`[probe] capturando ${target.key} → ${page}`)
        try {
          captured[target.key][page] = await capturePageRequests(page, 8000)
        } catch (err) {
          captured[target.key][page] = [
            { url: `ERRO: ${String(err)}`, method: '-', status: -1, body: null }
          ]
        }
      }
    }
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
        .slice(0, 8)

      for (const row of rows) {
        const key = `${target.key} | ${row.method} ${row.url.split('?')[0]}`
        try {
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
