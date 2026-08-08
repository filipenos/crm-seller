import { app } from 'electron'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

/**
 * Cópia em disco do JSON cru de cada pedido, um arquivo por `order_id`.
 *
 * Existe para que a análise não custe requisição: com a base inteira em
 * `userData/pedidos-json/`, dá para conferir campos, comparar formatos e testar
 * parsing quantas vezes for preciso sem tocar na Shopee. O banco guarda o que o
 * app usa; aqui fica tudo o que a Shopee mandou, inclusive o que ainda não
 * sabemos ler.
 */

function dumpDir(): string {
  return join(app.getPath('userData'), 'pedidos-json')
}

function historyDir(): string {
  return join(dumpDir(), 'historico')
}

/**
 * Guarda o JSON do pedido, versionando quando ele muda.
 *
 * A versão anterior vai para `historico/` porque o card **é reescrito** a cada
 * mudança de estado: quando um pedido é postado, o formato de "a enviar com
 * etiqueta" some para sempre. Guardar o antes é o que permite entender
 * transições — e foi olhando dois estados lado a lado que o campo da etiqueta
 * apareceu.
 */
export async function saveOrderDump(orderId: string, card: unknown): Promise<void> {
  const dir = dumpDir()
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${orderId}.json`)
  const novo = JSON.stringify(card, null, 2)

  try {
    const anterior = await readFile(file, 'utf8')
    if (anterior !== novo) {
      await mkdir(historyDir(), { recursive: true })
      // Carimbo no nome para nunca sobrescrever uma versão histórica.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await writeFile(join(historyDir(), `${orderId}-${stamp}.json`), anterior, 'utf8')
    }
  } catch {
    // Primeiro dump deste pedido: não há o que versionar.
  }

  await writeFile(file, novo, 'utf8')
}

export function dumpPath(): string {
  return dumpDir()
}

export async function countDumps(): Promise<number> {
  try {
    const files = await readdir(dumpDir())
    return files.filter((f) => f.endsWith('.json')).length
  } catch {
    return 0
  }
}

/**
 * Reaplica o parsing a todos os JSON salvos.
 *
 * É o que dá valor ao dump: quando o `normalizeCard` aprende a ler um campo
 * novo — como o código de envio que separa "etiqueta gerada" —, a base inteira
 * se atualiza sem uma requisição sequer.
 */
export async function reprocessDumps(
  upsert: (card: Record<string, unknown>) => void
): Promise<{ lidos: number; aplicados: number }> {
  let lidos = 0
  let aplicados = 0
  let files: string[] = []
  try {
    files = (await readdir(dumpDir())).filter((f) => f.endsWith('.json'))
  } catch {
    return { lidos: 0, aplicados: 0 }
  }
  for (const file of files) {
    try {
      const card = JSON.parse(await readFile(join(dumpDir(), file), 'utf8'))
      lidos++
      upsert(card)
      aplicados++
    } catch (err) {
      console.warn(`[dump] ${file} ilegível:`, err)
    }
  }
  return { lidos, aplicados }
}

/** Lê um dump salvo (útil para reprocessar sem rede). */
export async function readOrderDump(orderId: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(join(dumpDir(), `${orderId}.json`), 'utf8'))
  } catch {
    return null
  }
}
