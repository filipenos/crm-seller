/** Map a text's top-left anchor on the A4 preview to pdf-lib's rotated baseline. */
export function textOrigin(
  x: number,
  y: number,
  rotation: number,
  ascent: number,
  width: number,
  height: number
): { x: number; y: number } {
  const angle = rotation * Math.PI / 180
  return {
    x: x * width - Math.sin(angle) * ascent,
    y: height - y * height - Math.cos(angle) * ascent
  }
}

/** Shadow offsets are relative to the rotated text, like CSS text-shadow. */
export function shadowOrigin(
  origin: { x: number; y: number },
  rotation: number,
  offsetX: number,
  offsetY: number
): { x: number; y: number } {
  const angle = rotation * Math.PI / 180
  return {
    x: origin.x + Math.cos(angle) * offsetX - Math.sin(angle) * offsetY,
    y: origin.y - Math.sin(angle) * offsetX - Math.cos(angle) * offsetY
  }
}

export type TextBox = {
  x: number
  y: number
  rotation: number
  fontSize: number
  boxWidthMm?: number
  boxHeightMm?: number
  alignX?: 'left' | 'center' | 'right'
  alignY?: 'top' | 'center' | 'bottom'
}

export function layoutText(
  field: TextBox,
  pageWidth: number,
  pageHeight: number,
  textWidth: number,
  textHeight: number,
  ascent: number,
  inset = 0
): { origin: { x: number; y: number }; fontSize: number; textWidth: number; textHeight: number; left: number; top: number; boxWidth: number; boxHeight: number } {
  if (!field.boxWidthMm || !field.boxHeightMm) {
    return { origin: textOrigin(field.x, field.y, field.rotation, ascent, pageWidth, pageHeight), fontSize: field.fontSize,
      textWidth, textHeight, left: 0, top: 0, boxWidth: textWidth, boxHeight: textHeight }
  }
  const boxWidth = Math.max(1, field.boxWidthMm / 210 * pageWidth - 2 * inset)
  const boxHeight = Math.max(1, field.boxHeightMm / 297 * pageHeight - 2 * inset)
  const ratio = Math.min(1, textWidth > 0 ? boxWidth / textWidth : 1, textHeight > 0 ? boxHeight / textHeight : 1)
  const fittedWidth = textWidth * ratio
  const fittedHeight = textHeight * ratio
  const left = (boxWidth - fittedWidth) * ({ left: 0, center: 0.5, right: 1 }[field.alignX ?? 'center'])
  const top = (boxHeight - fittedHeight) * ({ top: 0, center: 0.5, bottom: 1 }[field.alignY ?? 'center'])
  const localX = left - boxWidth / 2
  const localY = top - boxHeight / 2 + ascent * ratio
  const angle = field.rotation * Math.PI / 180
  const screenX = field.x * pageWidth + Math.cos(angle) * localX - Math.sin(angle) * localY
  const screenY = field.y * pageHeight + Math.sin(angle) * localX + Math.cos(angle) * localY
  return { origin: { x: screenX, y: pageHeight - screenY }, fontSize: field.fontSize * ratio,
    textWidth: fittedWidth, textHeight: fittedHeight, left, top, boxWidth, boxHeight }
}

export function shadowSamples(offsetX: number, offsetY: number, size: number): { x: number; y: number }[] {
  if (size <= 0) return [{ x: offsetX, y: offsetY }]
  const samples = [{ x: offsetX, y: offsetY }]
  for (let index = 0; index < 8; index++) {
    const angle = index * Math.PI / 4
    samples.push({ x: offsetX + Math.cos(angle) * size, y: offsetY + Math.sin(angle) * size })
  }
  return samples
}

/** Overlapping copies create a solid outline around embedded PDF text. */
export function outlineSamples(width: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = []
  for (const [radius, count] of [[width, 24], [width / 2, 12]]) {
    for (let index = 0; index < count; index++) {
      const angle = index * 2 * Math.PI / count
      points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
    }
  }
  return points
}

/** Convert a pointer on a rotated preview back into the unrotated A4 page. */
export function previewPoint(
  clientX: number,
  clientY: number,
  centerX: number,
  centerY: number,
  rotation: number,
  width: number,
  height: number
): { x: number; y: number } {
  const angle = rotation * Math.PI / 180
  const dx = clientX - centerX
  const dy = clientY - centerY
  return {
    x: (Math.cos(angle) * dx + Math.sin(angle) * dy + width / 2) / width,
    y: (-Math.sin(angle) * dx + Math.cos(angle) * dy + height / 2) / height
  }
}

export function previewDragDelta(dx: number, dy: number, rotation: number, width: number, height: number): { x: number; y: number } {
  const angle = rotation * Math.PI / 180
  return {
    x: (Math.cos(angle) * dx + Math.sin(angle) * dy) / width,
    y: (-Math.sin(angle) * dx + Math.cos(angle) * dy) / height
  }
}
