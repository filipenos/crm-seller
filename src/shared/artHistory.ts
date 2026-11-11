import type { ArtTheme } from './artEditor'

export type ArtEditSnapshot = {
  theme: ArtTheme
  name: string
  age: string
  pageIndex: number
  selected: string | null
}

export type ArtEditHistory = { past: ArtEditSnapshot[]; future: ArtEditSnapshot[] }

export const emptyArtHistory = (): ArtEditHistory => ({ past: [], future: [] })

export function captureArtEdit(history: ArtEditHistory, snapshot: ArtEditSnapshot): ArtEditHistory {
  return { past: [...history.past, structuredClone(snapshot)].slice(-50), future: [] }
}

export function undoArtEdit(history: ArtEditHistory, current: ArtEditSnapshot): { history: ArtEditHistory; snapshot: ArtEditSnapshot } | null {
  const snapshot = history.past.at(-1)
  if (!snapshot) return null
  return { snapshot, history: { past: history.past.slice(0, -1), future: [...history.future, structuredClone(current)] } }
}

export function redoArtEdit(history: ArtEditHistory, current: ArtEditSnapshot): { history: ArtEditHistory; snapshot: ArtEditSnapshot } | null {
  const snapshot = history.future.at(-1)
  if (!snapshot) return null
  return { snapshot, history: { past: [...history.past, structuredClone(current)], future: history.future.slice(0, -1) } }
}
