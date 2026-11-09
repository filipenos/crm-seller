import type { ProductKind } from './types'

export function inferProductKind(name: string): ProductKind {
  return /^kit\s+(?:de\s+)?la[çc]os?\b/i.test(name.trim()) ? 'LACOS' : 'CAIXAS'
}

export function parseBowVariation(name: string | null): { color: string; size: number } | null {
  if (!name) return null
  const clean = name.trim().replace(/^(?:varia[çc][aã]o|variation)\s*:\s*/i, '')
  const match = /^(.+),\s*(10|20|30|40)\s*$/.exec(clean)
  if (!match) return null
  const color = match[1].trim()
  return color ? { color, size: Number(match[2]) } : null
}
