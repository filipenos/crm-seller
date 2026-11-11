export type ArtField = {
  id: string
  kind: 'name' | 'age'
  x: number
  y: number
  fontSize: number
  rotation: number
  color: string
  embolden?: number
  alignX?: 'left' | 'center' | 'right'
  alignY?: 'top' | 'center' | 'bottom'
  boxWidthMm?: number
  boxHeightMm?: number
  outline?: { color: string; width: number }
  shadow?: {
    color: string
    offsetX: number
    offsetY: number
    opacity: number
    size?: number
  }
}

export type ArtPage = {
  file: string
  label: string
  fields: ArtField[]
}

export type ArtTheme = {
  id: string
  name: string
  legacyId?: string
  fontFile?: string
  fontName?: string
  personalization?: { name: string; age: string }
  pages: ArtPage[]
}
