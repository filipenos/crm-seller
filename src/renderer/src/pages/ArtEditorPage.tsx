import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ArtField, ArtTheme } from '@shared/artEditor'
import { artAiPrompt, parseArtAiProposal } from '@shared/artAi'
import { captureArtEdit, emptyArtHistory, redoArtEdit, undoArtEdit, type ArtEditSnapshot } from '@shared/artHistory'
import { layoutText, previewDragDelta, previewPoint, shadowSamples } from '@shared/artGeometry'

GlobalWorkerOptions.workerSrc = pdfWorker

const previewScale = 600 / 595.32
function previewFontSize(field: ArtField, value: string, family: string, bold: boolean): number {
  if (!field.boxWidthMm || !field.boxHeightMm) return field.fontSize * previewScale
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return field.fontSize * previewScale
  context.font = `${bold ? '700' : '400'} ${field.fontSize * previewScale}px "${family}"`
  const metrics = context.measureText(value)
  const layout = layoutText(field, 595.32, 841.92, metrics.width / previewScale,
    (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) / previewScale,
    metrics.actualBoundingBoxAscent / previewScale,
    (field.outline?.width ?? 0) + (field.embolden ?? 0) + 1)
  return layout.fontSize * previewScale
}

function previewShadow(field: ArtField): string {
  const effects: string[] = []
  if (field.embolden) {
    for (let index = 0; index < 16; index++) {
      const angle = index * Math.PI / 8
      effects.push(`${Math.cos(angle) * field.embolden * previewScale}px ${Math.sin(angle) * field.embolden * previewScale}px 0 ${field.color}`)
    }
  }
  if (field.outline) {
    const count = 16
    for (let index = 0; index < count; index++) {
      const angle = index * Math.PI * 2 / count
      const radius = field.outline.width + (field.embolden ?? 0)
      effects.push(`${Math.cos(angle) * radius * previewScale}px ${Math.sin(angle) * radius * previewScale}px 0 ${field.outline.color}`)
    }
  }
  if (field.shadow) {
    const shadow = field.shadow
    const red = parseInt(shadow.color.slice(1, 3), 16)
    const green = parseInt(shadow.color.slice(3, 5), 16)
    const blue = parseInt(shadow.color.slice(5, 7), 16)
    effects.push(...shadowSamples(shadow.offsetX, shadow.offsetY, shadow.size ?? 0)
      .map((sample) => `${sample.x * previewScale}px ${sample.y * previewScale}px 0 rgba(${red}, ${green}, ${blue}, ${shadow.opacity})`))
  }
  return effects.length ? effects.join(', ') : 'none'
}

export default function ArtEditorPage({ orderSn = null, onBack }: { orderSn?: string | null; onBack?: () => void }): React.JSX.Element {
  const [themes, setThemes] = useState<ArtTheme[]>([])
  const [theme, setTheme] = useState<ArtTheme | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('MIGUEL')
  const [age, setAge] = useState('1 ANO')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [placing, setPlacing] = useState<ArtField['kind'] | null>(null)
  const [fontFamily, setFontFamily] = useState('Arial')
  const [fontStatus, setFontStatus] = useState<'default' | 'loading' | 'ready' | 'error'>('default')
  const [fontVersion, setFontVersion] = useState(0)
  const [viewRotation, setViewRotation] = useState(0)
  const [initialLoading, setInitialLoading] = useState(true)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiResponse, setAiResponse] = useState('')
  const [history, setHistory] = useState(emptyArtHistory)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const page = theme?.pages[pageIndex]
  const field = page?.fields.find((item) => item.id === selected)
  const requiresAge = theme?.pages.some((art) => art.fields.some((item) => item.kind === 'age')) ?? false

  useEffect(() => {
    setInitialLoading(true)
    const load = orderSn ? window.api.art.orderLoad(orderSn) : window.api.art.list().then((items) => ({ themes: items, name: '' }))
    void load.then(({ themes: items, name: orderName }) => {
      const preferredId = orderSn ? null : localStorage.getItem('art-editor-theme-id')
      const selectedTheme = items.find((item) => item.id === preferredId)
        ?? items.find((item) => item.fontFile && item.pages.some((page) => page.fields.length > 0))
        ?? items[0] ?? null
      setThemes(items); setTheme(selectedTheme)
      setHistory(emptyArtHistory())
      if (orderSn) { setName(items[0]?.personalization?.name ?? orderName); setAge(items[0]?.personalization?.age ?? '') }
    }).catch((reason) => setError(String(reason))).finally(() => setInitialLoading(false))
  }, [orderSn])

  useEffect(() => {
    if (!theme) return
    let canceled = false
    setFontFamily('Arial')
    if (!theme.fontFile) { setFontStatus('default'); return }
    setFontStatus('loading')
    void (orderSn ? window.api.art.orderLoadFont(orderSn, theme.id) : window.api.art.loadFont(theme.id)).then(async (data) => {
      if (!data || canceled) throw new Error('Arquivo da fonte não encontrado.')
      const family = `ArtTheme-${theme.id}-${fontVersion}`
      const face = new FontFace(family, new Uint8Array(data))
      await face.load()
      if (!canceled) { document.fonts.add(face); setFontFamily(family); setFontStatus('ready') }
    }).catch((reason) => { if (!canceled) { setFontStatus('error'); setError(`Não foi possível mostrar a fonte na prévia: ${String(reason)}`) } })
    return () => { canceled = true }
  }, [theme?.id, theme?.fontFile, fontVersion, orderSn])

  useEffect(() => {
    if (!theme || !page) return
    let canceled = false
    const canvas = canvasRef.current
    if (!canvas) return
    setPreviewLoading(true)
    void (async () => {
      const data = orderSn ? await window.api.art.orderLoadPdf(orderSn, theme.id, page.file) : await window.api.art.loadPdf(theme.id, page.file)
      const loadingTask = getDocument({ data: new Uint8Array(data) })
      const pdf = await loadingTask.promise
      try {
        const pdfPage = await pdf.getPage(1)
        const viewport = pdfPage.getViewport({ scale: 600 / pdfPage.getViewport({ scale: 1 }).width })
        if (canceled) return
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Não foi possível abrir a prévia.')
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise
      } finally {
        await loadingTask.destroy()
      }
    })().catch((reason) => { if (!canceled) setError(String(reason)) }).finally(() => { if (!canceled) setPreviewLoading(false) })
    return () => { canceled = true }
  }, [theme?.id, page?.file, orderSn])

  const snapshot = (): ArtEditSnapshot | null => theme ? { theme, name, age, pageIndex, selected } : null
  const capture = (): void => {
    const current = snapshot()
    if (current) setHistory((value) => captureArtEdit(value, current))
  }
  const restore = (value: ArtEditSnapshot): void => {
    setTheme(value.theme); setName(value.name); setAge(value.age)
    setPageIndex(value.pageIndex); setSelected(value.selected)
  }
  const undo = (): void => {
    const current = snapshot()
    if (!current) return
    const result = undoArtEdit(history, current)
    if (result) { setHistory(result.history); restore(result.snapshot); setMessage(null); setError(null) }
  }
  const redo = (): void => {
    const current = snapshot()
    if (!current) return
    const result = redoArtEdit(history, current)
    if (result) { setHistory(result.history); restore(result.snapshot); setMessage(null); setError(null) }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable) || !theme || busy) return
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' && event.key.toLowerCase() !== 'y') return
      event.preventDefault()
      if (event.key.toLowerCase() === 'y' || event.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const updateField = (id: string, patch: Partial<ArtField>, record = true): void => {
    if (record) capture()
    setTheme((current) => current && ({ ...current, pages: current.pages.map((item, index) => index === pageIndex
      ? { ...item, fields: item.fields.map((f) => f.id === id ? { ...f, ...patch } : f) }
      : item) }))
  }

  const addField = (kind: ArtField['kind'], x: number, y: number): void => {
    capture()
    const id = crypto.randomUUID()
    setTheme((current) => current && ({ ...current, pages: current.pages.map((item, index) => index === pageIndex
      ? { ...item, fields: [...item.fields, { id, kind, x, y, fontSize: 22, rotation: 0, color: '#000000',
        alignX: 'center', alignY: 'center', boxWidthMm: kind === 'name' ? 50 : 25, boxHeightMm: 12 }] }
      : item) }))
    setSelected(id)
    setPlacing(null)
  }

  const removeField = (): void => {
    if (!selected) return
    capture()
    setTheme((current) => current && ({ ...current, pages: current.pages.map((item, index) => index === pageIndex
      ? { ...item, fields: item.fields.filter((f) => f.id !== selected) }
      : item) }))
    setSelected(null)
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null); setMessage(null)
    try { await action() } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)) }
    finally { setBusy(false) }
  }

  const save = async (): Promise<void> => {
    if (!theme) return
    const saved = orderSn ? await window.api.art.orderSave(orderSn, theme, name, age) : await window.api.art.update(theme)
    setTheme(saved)
    setThemes((current) => current.map((item) => item.id === saved.id ? saved : item))
    setMessage(orderSn ? 'Ajustes salvos somente para este pedido.' : 'Regras do tema salvas neste computador.')
  }

  return <section className="art-editor">
    <header className="art-header"><div><h1>{orderSn ? `Arte do pedido ${orderSn}` : 'Editor de artes'}</h1><p className="muted">{orderSn ? 'Esta é uma cópia do tema. Seus ajustes não alteram o modelo.' : 'Defina as regras do tema uma vez. Confira a prévia antes de imprimir.'}</p></div><div className="art-header-actions">
      <button type="button" disabled={busy || history.past.length === 0} onClick={undo} title="Desfazer (Ctrl+Z)">↶ Desfazer</button>
      <button type="button" disabled={busy || history.future.length === 0} onClick={redo} title="Refazer (Ctrl+Y)">↷ Refazer</button>
      {onBack && <button onClick={onBack}>Voltar</button>}
      {!orderSn && <button disabled={busy} onClick={() => void run(async () => {
        const imported = theme ? await window.api.art.importPdfs(theme.id) : await window.api.art.import()
        if (imported) { setThemes((current) => current.some((item) => item.id === imported.id) ? current.map((item) => item.id === imported.id ? imported : item) : [...current, imported]); setTheme(imported); setHistory(emptyArtHistory()); localStorage.setItem('art-editor-theme-id', imported.id); setPageIndex(0); setSelected(null) }
      })}>{theme ? 'Importar PDFs neste tema' : 'Importar PDFs do tema'}</button>}</div></header>
    {error && <p className="art-error">{error}</p>}{message && <p className="art-message">{message}</p>}
    {initialLoading ? <p className="muted">Preparando artes…</p> : !theme ? <p className="muted">{orderSn ? 'Este pedido não tem tema vinculado. Faça o vínculo na tela Produtos.' : 'Cadastre um tema nas Configurações e importe os PDFs.'}</p> : <>
      <div className="art-toolbar"><label>Tema<select value={theme.id} onChange={(event) => { const next = themes.find((item) => item.id === event.target.value) ?? null; setTheme(next); setHistory(emptyArtHistory()); if (!orderSn && next) localStorage.setItem('art-editor-theme-id', next.id); setPageIndex(0); setSelected(null); if (orderSn) { setName(next?.personalization?.name ?? name); setAge(next?.personalization?.age ?? '') } }}>{themes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>{orderSn ? 'Nome da criança' : 'Nome de teste'}<input value={name} onChange={(event) => { capture(); setName(event.target.value) }} /></label>
        <label>{orderSn ? 'Idade' : 'Idade de teste'} {requiresAge ? '' : '(não usada neste tema)'}<input value={age} disabled={!requiresAge} onChange={(event) => { capture(); setAge(event.target.value) }} /></label></div>
      <div className="art-font-row"><span>Fonte {orderSn ? 'deste pedido' : 'do tema'}: <b>{theme.fontName ?? 'Padrão (Helvetica negrito)'}</b>{fontStatus === 'loading' && <small> · carregando…</small>}{fontStatus === 'ready' && <small> · arquivo carregado</small>}{fontStatus === 'error' && <small> · falha ao carregar</small>}</span><button disabled={busy} onClick={() => void run(async () => {
        const updated = orderSn ? await window.api.art.orderImportFont(orderSn, theme.id) : await window.api.art.importFont(theme.id)
        if (updated) { setTheme(updated); setHistory(emptyArtHistory()); setThemes((current) => current.map((item) => item.id === updated.id ? updated : item)); setFontVersion((value) => value + 1) }
      })}>Escolher fonte TTF/OTF</button></div>
      {!orderSn && theme.pages.length > 0 && <section className="art-ai-panel"><button type="button" onClick={() => setAiOpen((value) => !value)}>{aiOpen ? 'Ocultar assistente de IA' : 'Preparar com IA'}</button>
        {aiOpen && <div className="art-ai-content"><p>Copie o prompt e anexe os PDFs em branco no ChatGPT ou Gemini. Se tiver PDFs já personalizados, anexe também. A resposta será uma proposta para revisar aqui antes de salvar.</p>
          <button type="button" onClick={() => void run(async () => { await navigator.clipboard.writeText(artAiPrompt(theme)); setMessage('Prompt copiado. Anexe os PDFs no chat da IA.') })}>Copiar prompt</button>
          <label>Resposta JSON da IA<textarea value={aiResponse} onChange={(event) => setAiResponse(event.target.value)} placeholder='Cole aqui o JSON gerado pela IA' rows={6} /></label>
          <button type="button" disabled={!aiResponse.trim()} onClick={() => void run(async () => {
            const proposal = parseArtAiProposal(aiResponse, theme)
            capture()
            setTheme(proposal); setSelected(null); setPageIndex(0)
            setMessage('Proposta aplicada na prévia. Confira as cinco artes e salve as regras quando estiverem certas.')
          })}>Aplicar proposta na prévia</button>
        </div>}</section>}
      {theme.pages.length === 0 && <p className="muted">Este tema ainda não tem artes. Importe os PDFs para configurar nome e idade.</p>}
      {theme.pages.length > 0 && <div className="art-layout"><aside className="art-pages">{theme.pages.map((item, index) => <button key={item.file} className={index === pageIndex ? 'active' : ''} onClick={() => { setPageIndex(index); setSelected(null) }}>{index + 1}. {item.label}</button>)}</aside>
        <div className="art-stage-wrap"><div className="art-view-toolbar"><span>Visualização {viewRotation}° · a impressão não gira</span><button type="button" onClick={() => setViewRotation((value) => (value + 90) % 360)}>↻ Girar página</button></div><div className="art-stage-scroll">{previewLoading && <p className="art-preview-loading">Carregando arte…</p>}<div className="art-view-frame" style={{ width: viewRotation % 180 ? 849 : 600, height: viewRotation % 180 ? 600 : 849 }}><div className={`art-stage ${placing ? 'placing' : ''}`} style={{ transform: `translate(-50%, -50%) rotate(${viewRotation}deg)` }} ref={stageRef} onPointerDown={(event) => {
          if (!placing || event.target !== canvasRef.current) return
          const rect = stageRef.current?.getBoundingClientRect(); if (!rect) return
          const point = previewPoint(event.clientX, event.clientY, rect.left + rect.width / 2, rect.top + rect.height / 2, viewRotation, 600, 849)
          addField(placing, Math.min(1, Math.max(0, point.x)), Math.min(1, Math.max(0, point.y)))
        }}><canvas ref={canvasRef} />{page?.fields.map((item) => {
          const value = item.kind === 'name' ? name || 'Nome' : age || 'Idade'
          const boxed = Boolean(item.boxWidthMm && item.boxHeightMm)
          return <div key={item.id} className={`art-field ${boxed ? 'boxed' : ''} ${selected === item.id ? 'selected' : ''}`}
          style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`,
            width: boxed ? `${item.boxWidthMm! / 210 * 600}px` : undefined,
            height: boxed ? `${item.boxHeightMm! / 297 * 849}px` : undefined,
            justifyContent: boxed ? ({ left: 'flex-start', center: 'center', right: 'flex-end' } as const)[item.alignX ?? 'center'] : undefined,
            alignItems: boxed ? ({ top: 'flex-start', center: 'center', bottom: 'flex-end' } as const)[item.alignY ?? 'center'] : undefined,
            fontFamily, fontWeight: theme.fontFile ? 400 : 700,
            transform: `rotate(${item.rotation}deg)${boxed ? ' translate(-50%, -50%)' : ''}` }}
          onPointerDown={(event) => {
            event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setSelected(item.id)
            const target = event.currentTarget; const startX = event.clientX; const startY = event.clientY; const originalX = item.x; const originalY = item.y
            let recorded = false
            target.onpointermove = (move) => {
              if (!recorded) { capture(); recorded = true }
              const delta = previewDragDelta(move.clientX - startX, move.clientY - startY, viewRotation, 600, 849)
              updateField(item.id, { x: Math.min(1, Math.max(0, originalX + delta.x)), y: Math.min(1, Math.max(0, originalY + delta.y)) }, false)
            }
            target.onpointerup = () => { target.onpointermove = null; target.onpointerup = null }
          }}><span style={{ fontSize: `${previewFontSize(item, value, fontFamily, !theme.fontFile)}px`, color: item.color,
            textShadow: previewShadow(item) }}>{value}</span>
            {selected === item.id && <><button type="button" className="art-handle art-rotate-handle" title="Girar texto" onPointerDown={(event) => {
              event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
              const handle = event.currentTarget
              let recorded = false
              handle.onpointermove = (move) => {
                if (!recorded) { capture(); recorded = true }
                const rect = handle.parentElement?.getBoundingClientRect(); if (!rect) return
                const screenAngle = Math.atan2(move.clientY - (rect.top + rect.height / 2), move.clientX - (rect.left + rect.width / 2)) * 180 / Math.PI
                updateField(item.id, { rotation: (Math.round(screenAngle - viewRotation + 90) + 360) % 360 }, false)
              }
              handle.onpointerup = () => { handle.onpointermove = null; handle.onpointerup = null }
            }}>⟳</button>
            {boxed && <button type="button" className="art-handle art-scale-handle" title="Aumentar ou diminuir texto e área" onPointerDown={(event) => {
              event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
              const handle = event.currentTarget
              const startX = event.clientX; const startY = event.clientY
              const startWidth = item.boxWidthMm!; const startHeight = item.boxHeightMm!; const startFont = item.fontSize
              let recorded = false
              handle.onpointermove = (move) => {
                if (!recorded) { capture(); recorded = true }
                const delta = previewDragDelta(move.clientX - startX, move.clientY - startY, (viewRotation + item.rotation) % 360, 600, 849)
                const width = Math.min(210, Math.max(1, startWidth + 2 * delta.x * 210))
                const height = Math.min(297, Math.max(1, startHeight + 2 * delta.y * 297))
                const ratio = Math.min(width / startWidth, height / startHeight)
                updateField(item.id, { boxWidthMm: width, boxHeightMm: height, fontSize: Math.min(100, Math.max(4, startFont * ratio)) }, false)
              }
              handle.onpointerup = () => { handle.onpointermove = null; handle.onpointerup = null }
            }}>↘</button>}</>}
          </div>
        })}</div></div></div></div>
        <aside className="art-controls"><h2>Textos da arte</h2><div className="art-actions"><button className={placing === 'name' ? 'active' : ''} onClick={() => setPlacing('name')}>Posicionar nome</button><button className={placing === 'age' ? 'active' : ''} onClick={() => setPlacing('age')}>Posicionar idade</button></div>
          <p className="muted">{placing ? 'Clique no centro da área onde o texto deve aparecer.' : 'Arraste a área para ajustar. A fonte diminui automaticamente se o texto não couber.'}</p>
          {field && <><h3>{field.kind === 'name' ? 'Nome' : 'Idade'}</h3><label>Tamanho (pt)<input type="number" min="4" max="100" value={field.fontSize} onChange={(event) => updateField(field.id, { fontSize: Number(event.target.value) })} /></label>
            <label>Espessura extra (pt)<input type="number" min="0" max="3" step="0.25" value={field.embolden ?? 0} onChange={(event) => updateField(field.id, { embolden: Number(event.target.value) })} /></label>
            <label>Rotação (graus)<input type="number" min="0" max="359" step="1" value={field.rotation} onChange={(event) => updateField(field.id, { rotation: Number(event.target.value) })} /></label>
            <div className="art-rotation-presets">{[0, 90, 180, 270].map((angle) => <button key={angle} onClick={() => updateField(field.id, { rotation: angle })}>{angle}°</button>)}</div>
            <label>{field.boxWidthMm ? 'Centro horizontal (mm)' : 'Posição horizontal (mm)'}<input type="number" min="0" max="210" step="0.1" value={Math.round(field.x * 2100) / 10} onChange={(event) => updateField(field.id, { x: Number(event.target.value) / 210 })} /></label>
            <label>{field.boxHeightMm ? 'Centro vertical (mm)' : 'Posição vertical (mm)'}<input type="number" min="0" max="297" step="0.1" value={Math.round(field.y * 2970) / 10} onChange={(event) => updateField(field.id, { y: Number(event.target.value) / 297 })} /></label>
            {!field.boxWidthMm || !field.boxHeightMm ? <button onClick={() => updateField(field.id, { x: Math.min(1, field.x + 25 / 210), y: Math.min(1, field.y + 6 / 297), boxWidthMm: 50, boxHeightMm: 12, alignX: 'center', alignY: 'center' })}>Adicionar área máxima a este texto</button> : <>
              <label>Largura máxima (mm)<input type="number" min="1" max="210" step="0.5" value={field.boxWidthMm} onChange={(event) => updateField(field.id, { boxWidthMm: Number(event.target.value) })} /></label>
              <label>Altura máxima (mm)<input type="number" min="1" max="297" step="0.5" value={field.boxHeightMm} onChange={(event) => updateField(field.id, { boxHeightMm: Number(event.target.value) })} /></label>
              <label>Alinhamento horizontal<select value={field.alignX ?? 'center'} onChange={(event) => updateField(field.id, { alignX: event.target.value as ArtField['alignX'] })}><option value="left">Esquerda</option><option value="center">Centro</option><option value="right">Direita</option></select></label>
              <label>Alinhamento vertical<select value={field.alignY ?? 'center'} onChange={(event) => updateField(field.id, { alignY: event.target.value as ArtField['alignY'] })}><option value="top">Acima</option><option value="center">Centro</option><option value="bottom">Abaixo</option></select></label>
            </>}
            <label>Cor do texto<input type="color" value={field.color} onChange={(event) => updateField(field.id, { color: event.target.value })} /></label>
            <label className="art-checkbox"><input type="checkbox" checked={Boolean(field.outline)} onChange={(event) => updateField(field.id, { outline: event.target.checked ? { color: '#ffffff', width: 1.5 } : undefined })} /> Contorno</label>
            {field.outline && <div className="art-shadow-controls"><label>Cor do contorno<input type="color" value={field.outline.color} onChange={(event) => updateField(field.id, { outline: { ...field.outline!, color: event.target.value } })} /></label>
              <label>Espessura do contorno (pt)<input type="number" min="0.25" max="5" step="0.25" value={field.outline.width} onChange={(event) => updateField(field.id, { outline: { ...field.outline!, width: Number(event.target.value) } })} /></label></div>}
            <label className="art-checkbox"><input type="checkbox" checked={Boolean(field.shadow)} onChange={(event) => updateField(field.id, { shadow: event.target.checked ? { color: '#000000', offsetX: 1.5, offsetY: 1.5, opacity: 0.7, size: 0 } : undefined })} /> Sombra</label>
            {field.shadow && <div className="art-shadow-controls"><label>Cor da sombra<input type="color" value={field.shadow.color} onChange={(event) => updateField(field.id, { shadow: { ...field.shadow!, color: event.target.value } })} /></label>
              <label>Deslocamento X (pt)<input type="number" min="-20" max="20" step="0.5" value={field.shadow.offsetX} onChange={(event) => updateField(field.id, { shadow: { ...field.shadow!, offsetX: Number(event.target.value) } })} /></label>
              <label>Deslocamento Y (pt)<input type="number" min="-20" max="20" step="0.5" value={field.shadow.offsetY} onChange={(event) => updateField(field.id, { shadow: { ...field.shadow!, offsetY: Number(event.target.value) } })} /></label>
              <label>Tamanho da sombra (pt)<input type="number" min="0" max="5" step="0.5" value={field.shadow.size ?? 0} onChange={(event) => updateField(field.id, { shadow: { ...field.shadow!, size: Number(event.target.value) } })} /></label>
              <label>Intensidade (%)<input type="number" min="0" max="100" step="5" value={Math.round(field.shadow.opacity * 100)} onChange={(event) => updateField(field.id, { shadow: { ...field.shadow!, opacity: Number(event.target.value) / 100 } })} /></label></div>}
            <button className="art-remove" onClick={removeField}>Remover texto</button></>}
        </aside></div>}
      <footer className="art-footer"><button disabled={busy} onClick={() => void run(save)}>{orderSn ? 'Salvar ajustes do pedido' : 'Salvar regras do tema'}</button><button disabled={busy || theme.pages.length === 0 || !name.trim() || (requiresAge && !age.trim())} className="primary" onClick={() => void run(async () => { await save(); if (orderSn) await window.api.art.orderGenerate(orderSn, theme.id); else await window.api.art.generate(theme.id, name, age); setMessage('PDF aberto. Confira todas as páginas e imprima quando estiver correto.') })}>{busy ? 'Preparando…' : 'Gerar prévia para imprimir'}</button></footer>
    </>}
  </section>
}
