import assert from 'node:assert/strict'
import { layoutText, outlineSamples, previewDragDelta, previewPoint, shadowOrigin, shadowSamples, textOrigin } from '../src/shared/artGeometry'
import { artAiPrompt, parseArtAiProposal } from '../src/shared/artAi'
import { captureArtEdit, emptyArtHistory, redoArtEdit, undoArtEdit } from '../src/shared/artHistory'

const close = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-8)
const anchor = { x: 0.5, y: 0.25 }
const aiTheme = { id: 'teste', name: 'Teste', pages: [{ file: '1.pdf', label: 'Caixa', fields: [] }] }
const beforeEdit = { theme: aiTheme, name: 'MIGUEL', age: '1 ANO', pageIndex: 0, selected: null }
const afterEdit = { ...beforeEdit, name: 'ANA' }
const captured = captureArtEdit(emptyArtHistory(), beforeEdit)
const undone = undoArtEdit(captured, afterEdit)
assert.equal(undone?.snapshot.name, 'MIGUEL')
const redone = redoArtEdit(undone!.history, beforeEdit)
assert.equal(redone?.snapshot.name, 'ANA')
assert.equal(captureArtEdit(undone!.history, beforeEdit).future.length, 0)
assert.match(artAiPrompt(aiTheme), /1\.pdf/)
const aiProposal = parseArtAiProposal(JSON.stringify({ pages: [{ file: '1.pdf', fields: [{ kind: 'name', x: 0.5, y: 0.5, fontSize: 20, rotation: 90, color: '#ffffff', embolden: 0.75, boxWidthMm: 30, boxHeightMm: 10 }] }] }), aiTheme)
assert.equal(aiProposal.pages[0].fields.length, 1)
assert.equal(aiProposal.pages[0].fields[0].rotation, 90)
assert.equal(aiProposal.pages[0].fields[0].embolden, 0.75)
assert.throws(() => parseArtAiProposal('{"pages":[]}', aiTheme))
assert.throws(() => parseArtAiProposal(JSON.stringify({ pages: [{ file: '1.pdf', fields: [{ kind: 'name', x: 2, y: 0.5, fontSize: 20, rotation: 0, color: '#ffffff', boxWidthMm: 30, boxHeightMm: 10 }] }] }), aiTheme))
assert.throws(() => parseArtAiProposal(JSON.stringify({ pages: [{ file: '1.pdf', fields: [{ kind: 'name', x: 0.5, y: 0.5, fontSize: 20, rotation: 0, color: '#ffffff', embolden: 4, boxWidthMm: 30, boxHeightMm: 10 }] }] }), aiTheme))
const w = 600; const h = 800; const a = 20
for (const [rotation, expectedX, expectedY] of [
  [0, 300, 580], [90, 280, 600], [180, 300, 620], [270, 320, 600]
]) {
  const result = textOrigin(anchor.x, anchor.y, rotation, a, w, h)
  close(result.x, expectedX)
  close(result.y, expectedY)
}
const arbitrary = textOrigin(0.5, 0.25, 37, a, w, h)
close(arbitrary.x, 300 - Math.sin(37 * Math.PI / 180) * a)
close(arbitrary.y, 600 - Math.cos(37 * Math.PI / 180) * a)
const rightDown = shadowOrigin({ x: 100, y: 200 }, 0, 2, 3)
close(rightDown.x, 102); close(rightDown.y, 197)
const rotated = shadowOrigin({ x: 100, y: 200 }, 90, 2, 3)
close(rotated.x, 97); close(rotated.y, 198)
const centered = layoutText({ x: 0.5, y: 0.5, rotation: 0, fontSize: 20, boxWidthMm: 21, boxHeightMm: 10 }, 210, 297, 40, 8, 7)
close(centered.fontSize, 10.5)
close(centered.textWidth, 21)
close(centered.left, 0)
close(centered.top, 2.9)
close(centered.origin.x, 94.5)
close(centered.origin.y, 146.925)
const inset = layoutText({ x: 0.5, y: 0.5, rotation: 0, fontSize: 20, boxWidthMm: 21, boxHeightMm: 10 }, 210, 297, 40, 8, 7, 2)
assert.ok(inset.fontSize < centered.fontSize)
close(inset.boxWidth, 17)
const aligned = layoutText({ x: 0.5, y: 0.5, rotation: 90, fontSize: 20, boxWidthMm: 40, boxHeightMm: 20, alignX: 'right', alignY: 'bottom' }, 210, 297, 20, 10, 8)
close(aligned.fontSize, 20)
close(aligned.left, 20)
close(aligned.top, 10)
close(aligned.origin.x, 97)
close(aligned.origin.y, 148.5)
assert.equal(shadowSamples(2, 3, 0).length, 1)
assert.equal(shadowSamples(2, 3, 2).length, 9)
assert.equal(outlineSamples(2).length, 36)
close(outlineSamples(2)[0].x, 2)
close(outlineSamples(2)[0].y, 0)
const portraitPoint = previewPoint(600, 500, 500, 500, 0, 600, 849)
close(portraitPoint.x, 0.5 + 100 / 600); close(portraitPoint.y, 0.5)
const landscapePoint = previewPoint(600, 500, 500, 500, 90, 600, 849)
close(landscapePoint.x, 0.5); close(landscapePoint.y, 0.5 - 100 / 849)
const landscapeDrag = previewDragDelta(100, 0, 90, 600, 849)
close(landscapeDrag.x, 0); close(landscapeDrag.y, -100 / 849)
