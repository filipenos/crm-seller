import type { ArtField, ArtTheme } from './artEditor'

export function artAiPrompt(theme: ArtTheme): string {
  return `Analise os PDFs A4 em branco deste tema e, se anexados, os mesmos PDFs já personalizados. Configure APENAS os textos variáveis de nome e idade. Não altere a arte original.

Tema: ${theme.name}
Páginas, na ordem dos anexos: ${theme.pages.map((page) => `${page.file} (${page.label})`).join(', ')}.
Exemplo de nome: MIGUEL; idade: 1 ANO.

Use o PDF personalizado como referência principal para encontrar TODOS os lugares onde aparecem nome e idade, inclusive textos girados ou repetidos. Se não houver referência personalizada, estime a posição pelo espaço vazio e informe a incerteza fora do JSON. Não inclua textos fixos da arte. Nome e idade são campos separados. Uma página pode não usar idade.

Responda somente com um objeto JSON, sem Markdown, neste formato:
{"pages":[{"file":"1.pdf","fields":[{"kind":"name","x":0.5,"y":0.5,"fontSize":20,"rotation":0,"color":"#000000","boxWidthMm":30,"boxHeightMm":10,"alignX":"center","alignY":"center","outline":{"color":"#ffffff","width":1.5}}]}]}

Inclua exatamente uma entrada para cada página: ${theme.pages.map((page) => page.file).join(', ')}. Para cada ocorrência de texto, inclua um campo. x e y são o CENTRO da área máxima, normalizados de 0 a 1 a partir do canto superior esquerdo do A4 SEM girar a página. boxWidthMm e boxHeightMm são as dimensões máximas da área do texto em milímetros; o texto será reduzido automaticamente para caber. rotation é o giro do próprio texto em graus de 0 a 359. fontSize é o tamanho máximo em pontos, de 4 a 100. Use cor hexadecimal de seis dígitos. alignX pode ser left, center ou right; alignY pode ser top, center ou bottom. embolden, se necessário, aumenta a espessura do traço de 0 a 3 pontos sem trocar a fonte. Inclua outline e shadow somente se visíveis no exemplo. shadow, se necessário, usa color, offsetX, offsetY, opacity (0 a 1) e size (0 a 5).

Deixe margem dentro das áreas e entre nome e idade. Confira visualmente se nenhuma letra sai da placa ou da caixa. Não invente o nome de uma fonte: se a fonte exata não estiver disponível, estime a geometria e deixe a escolha da fonte para o editor.`
}

export function parseArtAiProposal(raw: string, theme: ArtTheme): ArtTheme {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let proposal: unknown
  try { proposal = JSON.parse(cleaned) } catch { throw new Error('A resposta precisa ser um JSON válido.') }
  if (!proposal || typeof proposal !== 'object' || !('pages' in proposal) || !Array.isArray(proposal.pages)) {
    throw new Error('A resposta precisa conter a lista de páginas.')
  }
  const pages = proposal.pages as unknown[]
  if (pages.length !== theme.pages.length) throw new Error('A resposta não contém todas as páginas do tema.')
  const byFile = new Map<string, ArtField[]>()
  for (const entry of pages) {
    if (!entry || typeof entry !== 'object' || !('file' in entry) || !('fields' in entry) ||
      typeof entry.file !== 'string' || !Array.isArray(entry.fields) || entry.fields.length > 30 || byFile.has(entry.file) ||
      !theme.pages.some((page) => page.file === entry.file)) throw new Error('Página ou campos inválidos na resposta.')
    const fields: ArtField[] = entry.fields.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('Campo de texto inválido na resposta.')
      const field = value as Partial<ArtField>
      if ((field.kind !== 'name' && field.kind !== 'age') || !Number.isFinite(field.x) || field.x! < 0 || field.x! > 1 ||
        !Number.isFinite(field.y) || field.y! < 0 || field.y! > 1 || !Number.isFinite(field.fontSize) || field.fontSize! < 4 || field.fontSize! > 100 ||
        !Number.isInteger(field.rotation) || field.rotation! < 0 || field.rotation! >= 360 || !/^#[0-9a-fA-F]{6}$/.test(field.color ?? '') ||
        !Number.isFinite(field.boxWidthMm) || field.boxWidthMm! < 1 || field.boxWidthMm! > 210 ||
        !Number.isFinite(field.boxHeightMm) || field.boxHeightMm! < 1 || field.boxHeightMm! > 297 ||
        !['left', 'center', 'right'].includes(field.alignX ?? 'center') || !['top', 'center', 'bottom'].includes(field.alignY ?? 'center')) {
        throw new Error('A resposta contém posição ou estilo de texto inválido.')
      }
      if (field.outline && (!/^#[0-9a-fA-F]{6}$/.test(field.outline.color) || !Number.isFinite(field.outline.width) || field.outline.width < 0.25 || field.outline.width > 5)) throw new Error('Contorno inválido na resposta.')
      if (field.embolden !== undefined && (!Number.isFinite(field.embolden) || field.embolden < 0 || field.embolden > 3)) throw new Error('Espessura inválida na resposta.')
      if (field.shadow && (!/^#[0-9a-fA-F]{6}$/.test(field.shadow.color) || !Number.isFinite(field.shadow.offsetX) || Math.abs(field.shadow.offsetX) > 20 || !Number.isFinite(field.shadow.offsetY) || Math.abs(field.shadow.offsetY) > 20 || !Number.isFinite(field.shadow.opacity) || field.shadow.opacity < 0 || field.shadow.opacity > 1 || !Number.isFinite(field.shadow.size ?? 0) || (field.shadow.size ?? 0) < 0 || (field.shadow.size ?? 0) > 5)) throw new Error('Sombra inválida na resposta.')
      return { kind: field.kind, id: crypto.randomUUID(), x: field.x!, y: field.y!, fontSize: field.fontSize!, rotation: field.rotation!, color: field.color!, embolden: field.embolden, boxWidthMm: field.boxWidthMm!, boxHeightMm: field.boxHeightMm!, alignX: field.alignX ?? 'center', alignY: field.alignY ?? 'center', outline: field.outline, shadow: field.shadow }
    })
    byFile.set(entry.file, fields)
  }
  return { ...theme, pages: theme.pages.map((page) => ({ ...page, fields: byFile.get(page.file)! })) }
}
