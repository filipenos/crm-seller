import { useEffect, useMemo, useState } from 'react'
import {
  TIPO_ITEM_COMPOSICAO_LABELS,
  TIPOS_ITEM_COMPOSICAO,
  UNIDADES,
  type ConsumoProducao,
  type ItemComposicao,
  type ResumoComposicao,
  type TipoItemComposicao
} from '@shared/types'

interface Props { dataVersion: number }
type Tab = 'itens' | 'estrutura' | 'custos' | 'producao' | 'estoque'
type Run = (action: () => Promise<unknown>) => Promise<boolean>

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const numeric = (value: string): number => Number(value.replace(',', '.'))
const validPositive = (value: string): boolean => Number.isFinite(numeric(value)) && numeric(value) > 0
const validNonNegative = (value: string): boolean => Number.isFinite(numeric(value)) && numeric(value) >= 0
const today = (): string => new Date().toISOString().slice(0, 10)

function money(value: number | null): string {
  if (value === null) return '—'
  if (value === 0 || Math.abs(value) >= 1) return BRL.format(value)
  return `R$ ${value.toFixed(4).replace(/(\d\d)(0+)$/, '$1').replace('.', ',')}`
}

function errorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  const clean = message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
  if (/fetch failed|connect(?:ion)? timeout|UND_ERR_CONNECT_TIMEOUT/i.test(clean)) {
    return 'Não foi possível conectar ao Turso. Confira a internet e tente novamente.'
  }
  return clean
}

export default function ProducaoPage({ dataVersion }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('estrutura')
  const [summary, setSummary] = useState<ResumoComposicao | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (showLoading = true): Promise<void> => {
    if (showLoading) setLoading(true)
    setError(null)
    try { setSummary(await window.api.composicao.resumo()) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { if (showLoading) setLoading(false) }
  }
  const run: Run = async (action) => {
    setError(null)
    setWorking(true)
    try {
      try {
        await action()
      } catch (reason) {
        setError(errorMessage(reason))
        return false
      }
      await load(false)
      return true
    } finally {
      setWorking(false)
    }
  }
  useEffect(() => { void load(true) }, [dataVersion])
  useEffect(() => {
    if (!error) return
    const timeout = window.setTimeout(() => setError(null), 8000)
    return () => window.clearTimeout(timeout)
  }, [error])

  return <div className="page composicao-page">
    <header className="page-header"><div><h1>Composição</h1><span className="muted">do material comprado ao kit pronto</span></div></header>
    <div className="abas">
      {([['itens', 'Itens'], ['estrutura', 'Estrutura'], ['custos', 'Custos'], ['producao', 'Lotes de produção'], ['estoque', 'Estoque']] as [Tab, string][]).map(([value, label]) =>
        <button key={value} className={tab === value ? 'ativa' : ''} onClick={() => { setError(null); setTab(value) }}>{label}</button>)}
    </div>
    {error && <div className="aviso alerta composicao-alerta"><span>{errorMessage(error)}</span><button className="alert-close" aria-label="Fechar aviso" title="Fechar" onClick={() => setError(null)}>×</button></div>}
    {working && <div className="operation-status"><span className="spinner" /> Salvando e atualizando custos…</div>}
    {loading && <div className="empty loading-indicator">Carregando composição…</div>}
    {!loading && summary && tab === 'itens' && <ItemsTab summary={summary} run={run} />}
    {!loading && summary && tab === 'estrutura' && <StructureTab summary={summary} run={run} />}
    {!loading && summary && tab === 'custos' && <CostsTab summary={summary} run={run} />}
    {!loading && summary && tab === 'producao' && <ProductionTab summary={summary} run={run} />}
    {!loading && summary && tab === 'estoque' && <StockTab summary={summary} run={run} />}
  </div>
}

function ItemsTab({ summary, run }: { summary: ResumoComposicao; run: Run }): React.JSX.Element {
  type ItemForm = { id: number | null; nome: string; tipo: TipoItemComposicao; unidade: string; vendavel: boolean; controlaEstoque: boolean; custoReferencia: string; perdaPercentual: string; observacao: string }
  const emptyForm = (): ItemForm => ({ id: null, nome: '', tipo: 'MATERIA_PRIMA', unidade: 'un', vendavel: false, controlaEstoque: true, custoReferencia: '', perdaPercentual: '0', observacao: '' })
  const [form, setForm] = useState<ItemForm | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [selectedId, setSelectedId] = useState(summary.itens[0]?.id ?? 0)
  const [variantName, setVariantName] = useState('')
  const [editingVariant, setEditingVariant] = useState<{ id: number; nome: string } | null>(null)
  const selected = summary.itens.find((item) => item.id === selectedId) ?? summary.itens[0]
  const startEdit = (item: ItemComposicao): void => {
    setAttempted(false)
    setForm({ id: item.id,
    nome: item.nome,
    tipo: item.tipo,
    unidade: item.unidade,
    vendavel: item.vendavel,
    controlaEstoque: item.controlaEstoque,
    custoReferencia: item.custoReferencia === null ? '' : String(item.custoReferencia).replace('.', ','),
    perdaPercentual: String(item.perdaPercentual).replace('.', ','),
      observacao: item.observacao ?? ''
    })
  }
  const save = async (): Promise<void> => {
    setAttempted(true)
    if (!form?.nome.trim() || (form.custoReferencia.trim() !== '' && !Number.isFinite(numeric(form.custoReferencia))) || !Number.isFinite(numeric(form.perdaPercentual))) return
    const input = {
      nome: form.nome,
      tipo: form.tipo,
      unidade: form.unidade,
      vendavel: form.vendavel,
      controlaEstoque: form.controlaEstoque,
      custoReferencia: form.custoReferencia.trim() ? numeric(form.custoReferencia) : null,
      perdaPercentual: form.perdaPercentual.trim() ? numeric(form.perdaPercentual) : 0,
      observacao: form.observacao || null
    }
    const ok = form.id === null
      ? await run(() => window.api.composicao.criarItem(input))
      : await run(() => window.api.composicao.atualizarItem(form.id!, input))
    if (ok) { setForm(null); setAttempted(false) }
  }
  const addVariant = async (): Promise<void> => {
    if (!selected || !variantName.trim()) return
    if (await run(() => window.api.composicao.criarVariante(selected.id, variantName))) setVariantName('')
  }
  return <div className="cadastro-layout">
    <section>
      <div className="section-toolbar"><h3>Itens cadastrados</h3><button className="primario" onClick={() => { setAttempted(false); setForm(emptyForm()) }}>Novo item</button></div>
      <div className="composicao-lista">{summary.itens.map((item) => <button key={item.id} className={selected?.id === item.id ? 'selecionado' : ''} onClick={() => { setSelectedId(item.id); setForm(null) }}><span><b>{item.nome}</b><small>{TIPO_ITEM_COMPOSICAO_LABELS[item.tipo]} · {item.unidade}</small></span><span>{money(item.custoEstimado)}</span></button>)}</div>
    </section>
    <section className="composicao-detalhe">
      {form ? <><h3>{form.id === null ? 'Novo item' : 'Editar item'}</h3><div className="crud-form">
        <label><span className="required">Nome</span><input className={attempted && !form.nome.trim() ? 'invalid' : ''} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />{attempted && !form.nome.trim() && <span className="field-error">Informe o nome.</span>}</label>
        <label><span className="required">Tipo</span><select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as TipoItemComposicao })}>{TIPOS_ITEM_COMPOSICAO.map((kind) => <option key={kind} value={kind}>{TIPO_ITEM_COMPOSICAO_LABELS[kind]}</option>)}</select></label>
        <label><span className="required">Unidade de controle</span><select value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value })}>{UNIDADES.map((unit) => <option key={unit}>{unit}</option>)}</select></label>
        <label>Custo de referência por {form.unidade}<input className={attempted && form.custoReferencia.trim() !== '' && !Number.isFinite(numeric(form.custoReferencia)) ? 'invalid' : ''} value={form.custoReferencia} onChange={(e) => setForm({ ...form, custoReferencia: e.target.value })} placeholder="Opcional; compras têm prioridade" /></label>
        <label><span className="required">Perda estimada (%)</span><input className={attempted && !Number.isFinite(numeric(form.perdaPercentual)) ? 'invalid' : ''} value={form.perdaPercentual} onChange={(e) => setForm({ ...form, perdaPercentual: e.target.value })} /></label>
        <label className="full">Observações<textarea value={form.observacao} onChange={(e) => setForm({ ...form, observacao: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={form.controlaEstoque} onChange={(e) => setForm({ ...form, controlaEstoque: e.target.checked })} /> Controlar estoque</label>
        <label className="check"><input type="checkbox" checked={form.vendavel} onChange={(e) => setForm({ ...form, vendavel: e.target.checked })} /> Pode ser vendido</label>
      </div><div className="form-actions"><button className="primario" onClick={() => void save()}>Salvar item</button><button onClick={() => setForm(null)}>Cancelar</button></div></> : selected ? <>
        <div className="section-toolbar"><div><h3>{selected.nome}</h3><p className="muted">{TIPO_ITEM_COMPOSICAO_LABELS[selected.tipo]} · controlado em {selected.unidade}</p></div><div><button onClick={() => startEdit(selected)}>Editar item</button> <button className="apagar" onClick={() => { if (window.confirm(`Remover "${selected.nome}"? Ele também será retirado das estruturas em que aparece.`)) void run(() => window.api.composicao.removerItem(selected.id)) }}>Remover</button></div></div>
        <dl className="item-details"><div><dt>Custo estimado</dt><dd>{money(selected.custoEstimado)}/{selected.unidade}</dd></div><div><dt>Custo de referência</dt><dd>{money(selected.custoReferencia)}/{selected.unidade}</dd></div><div><dt>Perda</dt><dd>{selected.perdaPercentual}%</dd></div><div><dt>Estoque</dt><dd>{selected.controlaEstoque ? 'Controlado' : 'Não controlado'}</dd></div><div><dt>Venda</dt><dd>{selected.vendavel ? 'Permitida' : 'Não permitida'}</dd></div></dl>
        {selected.observacao && <p>{selected.observacao}</p>}
        <h4>Versões ou temas</h4>
        <div className="variant-list">{selected.variantes.map((variant) => <div key={variant.id}>{editingVariant?.id === variant.id ? <><input value={editingVariant.nome} onChange={(e) => setEditingVariant({ ...editingVariant, nome: e.target.value })} /><button onClick={() => void run(() => window.api.composicao.atualizarVariante(variant.id, editingVariant.nome)).then((ok) => { if (ok) setEditingVariant(null) })}>Salvar</button><button onClick={() => setEditingVariant(null)}>Cancelar</button></> : <><span>{variant.nome}</span><button onClick={() => setEditingVariant({ id: variant.id, nome: variant.nome })}>Editar</button><button className="apagar" disabled={selected.variantes.length === 1} onClick={() => void run(() => window.api.composicao.removerVariante(variant.id))}>Remover</button></>}</div>)}</div>
        <div className="form-linha"><input value={variantName} onChange={(e) => setVariantName(e.target.value)} placeholder="Nova versão ou tema" /><button onClick={() => void addVariant()}>Adicionar versão</button></div>
      </> : <div className="empty">Cadastre o primeiro item.</div>}
    </section>
  </div>
}

function StructureTab({ summary, run }: { summary: ResumoComposicao; run: Run }): React.JSX.Element {
  const initial = summary.itens.find((item) => item.tipo === 'KIT')?.id ?? summary.itens[0]?.id ?? 0
  const [selectedId, setSelectedId] = useState(initial)
  const [childId, setChildId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [partQuantities, setPartQuantities] = useState<Record<number, string>>({})
  const [sizeForm, setSizeForm] = useState<{ id: number | null; total: string; multiplicador: string } | null>(null)
  const [addAttempted, setAddAttempted] = useState(false)
  const [sizeAttempted, setSizeAttempted] = useState(false)
  const selected = summary.itens.find((item) => item.id === selectedId) ?? summary.itens[0]
  const itemById = useMemo(() => new Map(summary.itens.map((item) => [item.id, item])), [summary.itens])
  useEffect(() => {
    setPartQuantities(Object.fromEntries((selected?.partes ?? []).map((part) => [part.id, part.quantidade === null ? '' : String(part.quantidade).replace('.', ',')])))
  }, [selectedId, selected?.partes])
  const add = async (): Promise<void> => {
    setAddAttempted(true)
    if (!selected || !childId || (quantity.trim() !== '' && !validPositive(quantity))) return
    if (await run(() => window.api.composicao.definirParte({ itemId: selected.id, componenteId: Number(childId), quantidade: quantity.trim() ? numeric(quantity) : null }))) {
      setChildId(''); setQuantity(''); setAddAttempted(false)
    }
  }
  if (!selected) return <div className="empty">Cadastre o primeiro item para montar uma composição.</div>
  const sizes = summary.tamanhosKit.filter((size) => size.kitItemId === selected.id)
  const child = summary.itens.find((item) => item.id === Number(childId))
  const saveSize = async (): Promise<void> => {
    setSizeAttempted(true)
    if (!sizeForm || !validPositive(sizeForm.total) || !validPositive(sizeForm.multiplicador)) return
    const input = { totalCaixas: numeric(sizeForm.total), multiplicador: numeric(sizeForm.multiplicador) }
    const ok = sizeForm.id === null
      ? await run(() => window.api.composicao.criarTamanhoKit({ itemId: selected.id, ...input }))
      : await run(() => window.api.composicao.atualizarTamanhoKit(sizeForm.id!, input))
    if (ok) { setSizeForm(null); setSizeAttempted(false) }
  }
  return <div className="composicao-grid">
    <aside className="composicao-lista">{summary.itens.filter((item) => item.tipo !== 'MATERIA_PRIMA').map((item) =>
      <button key={item.id} className={item.id === selected.id ? 'selecionado' : ''} onClick={() => setSelectedId(item.id)}><span>{item.nome}</span><small>{money(item.custoEstimado)}</small></button>)}</aside>
    <section className="bloco composicao-detalhe"><h3>{selected.nome} <span className="tag suave">{TIPO_ITEM_COMPOSICAO_LABELS[selected.tipo]}</span></h3>
      <p className="muted">Custo estimado: <b>{selected.custoIncompleto ? 'a partir de ' : ''}{money(selected.custoEstimado)}</b></p>
      <CompositionTree item={selected} itemById={itemById} path={[]} />
      {selected.partes.length > 0 && <div className="composicao-partes-editor"><h4>Editar quantidades</h4>{selected.partes.map((part) => <div className="composicao-parte-linha" key={part.id}><span>{part.nome}</span><div><input className="curto" value={partQuantities[part.id] ?? ''} placeholder="A medir" onChange={(e) => setPartQuantities({ ...partQuantities, [part.id]: e.target.value })} /> <span className="muted">{part.unidade} por {selected.unidade}</span></div><button onClick={() => void run(() => window.api.composicao.definirParte({ itemId: selected.id, componenteId: part.itemId, quantidade: partQuantities[part.id]?.trim() ? numeric(partQuantities[part.id]) : null }))}>Salvar</button><button className="apagar" onClick={() => void run(() => window.api.composicao.removerParte(part.id))}>Remover</button></div>)}</div>}
      <div className="form-linha compacta">
        <select className={addAttempted && !childId ? 'invalid' : ''} value={childId} onChange={(e) => setChildId(e.target.value)}><option value="">Adicionar item *…</option>{summary.itens.filter((item) => item.id !== selected.id && !selected.partes.some((part) => part.itemId === item.id)).map((item) => <option key={item.id} value={item.id}>{item.nome} ({item.unidade})</option>)}</select>
        <input className={`curto ${addAttempted && quantity.trim() !== '' && !validPositive(quantity) ? 'invalid' : ''}`} placeholder={child ? `Qtd em ${child.unidade}` : 'Quantidade'} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <button onClick={() => void add()}>Adicionar</button></div>
      <p className="muted small">A quantidade sempre usa a unidade do componente. Ex.: 30 cm de fita para produzir 1 laço.</p>
      {selected.tipo === 'KIT' && <div className="kit-sizes"><div className="section-toolbar"><h4>Tamanhos comerciais</h4><button onClick={() => { setSizeAttempted(false); setSizeForm({ id: null, total: '', multiplicador: '' }) }}>Novo tamanho</button></div>{sizeForm && <div className="composicao-editor-inline"><label><span className="required">Total de caixas</span> <input className={`curto ${sizeAttempted && !validPositive(sizeForm.total) ? 'invalid' : ''}`} value={sizeForm.total} onChange={(e) => setSizeForm({ ...sizeForm, total: e.target.value })} /></label><label><span className="required">Multiplicador da composição</span> <input className={`curto ${sizeAttempted && !validPositive(sizeForm.multiplicador) ? 'invalid' : ''}`} value={sizeForm.multiplicador} onChange={(e) => setSizeForm({ ...sizeForm, multiplicador: e.target.value })} /></label><button className="primario" onClick={() => void saveSize()}>Salvar</button><button onClick={() => setSizeForm(null)}>Cancelar</button></div>}<table className="tabela"><thead><tr><th>Caixas</th><th>Multiplicador</th><th>Custo estimado</th><th></th></tr></thead><tbody>{sizes.map((size) => <tr key={size.id}><td>{size.totalCaixas}</td><td>{size.multiplicador}×</td><td>{money(size.custoEstimado)}</td><td className="acoes"><button onClick={() => { setSizeAttempted(false); setSizeForm({ id: size.id, total: String(size.totalCaixas), multiplicador: String(size.multiplicador).replace('.', ',') }) }}>Editar</button><button className="apagar" onClick={() => void run(() => window.api.composicao.removerTamanhoKit(size.id))}>Remover</button></td></tr>)}</tbody></table></div>}
    </section>
  </div>
}

function CompositionTree({ item, itemById, path }: { item: ItemComposicao; itemById: Map<number, ItemComposicao>; path: number[] }): React.JSX.Element {
  if (path.includes(item.id)) return <span className="aviso alerta">Ciclo detectado</span>
  if (!item.partes.length) return <span className="muted small">Sem composição: custo vem das compras ou do valor de referência.</span>
  return <ul className="composition-tree">{item.partes.map((part) => {
    const child = itemById.get(part.itemId)
    return <li key={part.id}><div><b>{part.quantidade === null ? 'quantidade pendente' : `${part.quantidade.toLocaleString('pt-BR')} ${part.unidade}`}</b> de {part.nome}<span className="muted"> · {money(part.custo)}</span></div>{child && child.partes.length > 0 && <CompositionTree item={child} itemById={itemById} path={[...path, item.id]} />}</li>
  })}</ul>
}

function CostsTab({ summary, run }: { summary: ResumoComposicao; run: Run }): React.JSX.Element {
  const materials = summary.itens.filter((item) => item.tipo === 'MATERIA_PRIMA')
  const [form, setForm] = useState({ purchaseId: null as number | null, itemId: '', variantId: '', volumes: '', conteudo: '1', valor: '', frete: '', data: today(), fornecedor: '' })
  const [attempted, setAttempted] = useState(false)
  const selected = materials.find((item) => item.id === Number(form.itemId))
  const reset = (): void => {
    setAttempted(false)
    setForm({ purchaseId: null, itemId: '', variantId: '', volumes: '', conteudo: '1', valor: '', frete: '', data: today(), fornecedor: '' })
  }
  const submit = async (): Promise<void> => {
    setAttempted(true)
    if (!selected || !validPositive(form.volumes) || !validPositive(form.conteudo) || !validNonNegative(form.valor) || !form.data) return
    const input = { itemId: selected.id, variantId: form.variantId ? Number(form.variantId) : selected.variantes[0]?.id ?? null, quantidade: numeric(form.volumes) * numeric(form.conteudo), valor: numeric(form.valor), frete: form.frete ? numeric(form.frete) : 0, compradoEm: new Date(`${form.data}T12:00:00`).getTime(), fornecedor: form.fornecedor || null }
    const ok = form.purchaseId === null
      ? await run(() => window.api.composicao.registrarCompra(input))
      : await run(() => window.api.composicao.atualizarCompra(form.purchaseId!, input))
    if (ok) reset()
  }
  const costItems = summary.itens.filter((item) => item.custoEstimado !== null && item.tipo !== 'MATERIA_PRIMA')
  return <div className="costs-layout">
    <section className="cost-card">
      <div className="section-toolbar"><div><h3>{form.purchaseId === null ? 'Registrar compra' : 'Editar compra'}</h3><p className="muted">A quantidade é convertida para a unidade usada na composição.</p></div>{form.purchaseId !== null && <button onClick={reset}>Cancelar edição</button>}</div>
      <div className="cost-form-grid">
        <label><span className="required">Matéria-prima</span><select className={attempted && !selected ? 'invalid' : ''} value={form.itemId} onChange={(e) => { const item = materials.find((candidate) => candidate.id === Number(e.target.value)); setForm({ ...form, itemId: e.target.value, variantId: item?.variantes[0] ? String(item.variantes[0].id) : '', conteudo: '1' }) }}><option value="">Selecione…</option>{materials.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}</select></label>
        <label>Versão<select value={form.variantId} onChange={(e) => setForm({ ...form, variantId: e.target.value })}><option value="">Padrão</option>{selected?.variantes.map((variant) => <option key={variant.id} value={variant.id}>{variant.nome}</option>)}</select></label>
        <label><span className="required">Volumes comprados</span><input className={attempted && !validPositive(form.volumes) ? 'invalid' : ''} placeholder="Ex.: 1" value={form.volumes} onChange={(e) => setForm({ ...form, volumes: e.target.value })} /></label>
        <label><span className="required">Conteúdo por volume</span><div className="input-with-unit"><input className={attempted && !validPositive(form.conteudo) ? 'invalid' : ''} placeholder="Ex.: 1000" value={form.conteudo} onChange={(e) => setForm({ ...form, conteudo: e.target.value })} /><span>{selected?.unidade ?? 'unidade'}</span></div></label>
        <label><span className="required">Valor pago</span><div className="input-prefix"><span>R$</span><input className={attempted && !validNonNegative(form.valor) ? 'invalid' : ''} placeholder="0,00" value={form.valor} onChange={(e) => setForm({ ...form, valor: e.target.value })} /></div></label>
        <label>Frete<div className="input-prefix"><span>R$</span><input placeholder="0,00" value={form.frete} onChange={(e) => setForm({ ...form, frete: e.target.value })} /></div></label>
        <label><span className="required">Data</span><input className={attempted && !form.data ? 'invalid' : ''} type="date" value={form.data} onChange={(e) => setForm({ ...form, data: e.target.value })} /></label>
        <label>Fornecedor<input placeholder="Opcional" value={form.fornecedor} onChange={(e) => setForm({ ...form, fornecedor: e.target.value })} /></label>
      </div>
      {attempted && (!selected || !validPositive(form.volumes) || !validPositive(form.conteudo) || !validNonNegative(form.valor) || !form.data) && <p className="field-error">Revise os campos destacados.</p>}
      {selected && <div className="cost-preview"><span>Total no estoque</span><strong>{validPositive(form.volumes) && validPositive(form.conteudo) ? (numeric(form.volumes) * numeric(form.conteudo)).toLocaleString('pt-BR') : '—'} {selected.unidade}</strong><small>Ex.: 1 rolo × 1.000 cm por R$ 20 = R$ 0,02/cm</small></div>}
      <div className="form-actions"><button className="primario" onClick={() => void submit()}>{form.purchaseId === null ? 'Registrar compra' : 'Salvar alterações'}</button></div>
    </section>

    <section className="cost-card"><h3>Custos das composições</h3><div className="cost-summary-grid">{costItems.map((item) => <div className="cost-summary" key={item.id}><span>{item.nome}</span><strong>{item.custoIncompleto ? '≥ ' : ''}{money(item.custoEstimado)}</strong><small>por {item.unidade}</small></div>)}</div></section>

    <section className="cost-card"><h3>Histórico de compras</h3>{summary.compras.length === 0 ? <div className="empty">Nenhuma compra registrada.</div> : <div className="table-scroll"><table className="tabela"><thead><tr><th>Data</th><th>Item</th><th>Versão</th><th className="num">Quantidade</th><th className="num">Total</th><th className="num">Custo unitário</th><th>Fornecedor</th><th></th></tr></thead><tbody>{summary.compras.map((purchase) => { const item = summary.itens.find((candidate) => candidate.id === purchase.itemId); return <tr key={purchase.id}><td>{new Date(purchase.compradoEm).toLocaleDateString('pt-BR')}</td><td><b>{purchase.itemNome}</b></td><td>{purchase.varianteNome ?? 'Padrão'}</td><td className="num">{purchase.quantidade.toLocaleString('pt-BR')} {item?.unidade}</td><td className="num">{BRL.format(purchase.valor + purchase.frete)}</td><td className="num">{money(purchase.custoUnitario)}/{item?.unidade}</td><td>{purchase.fornecedor ?? '—'}</td><td className="acoes"><button onClick={() => setForm({ purchaseId: purchase.id, itemId: String(purchase.itemId), variantId: purchase.varianteId === null ? '' : String(purchase.varianteId), volumes: String(purchase.quantidade).replace('.', ','), conteudo: '1', valor: String(purchase.valor).replace('.', ','), frete: String(purchase.frete).replace('.', ','), data: new Date(purchase.compradoEm).toISOString().slice(0, 10), fornecedor: purchase.fornecedor ?? '' })}>Editar</button><button className="danger" onClick={() => { if (window.confirm('Remover esta compra e sua entrada no estoque?')) void run(() => window.api.composicao.removerCompra(purchase.id)) }}>Remover</button></td></tr> })}</tbody></table></div>}</section>
  </div>
}

function ProductionTab({ summary, run }: { summary: ResumoComposicao; run: Run }): React.JSX.Element {
  const producible = summary.itens.filter((item) => item.partes.length > 0)
  const [itemId, setItemId] = useState(String(producible[0]?.id ?? ''))
  const selectedItem = producible.find((item) => item.id === Number(itemId))
  const sizes = summary.tamanhosKit.filter((size) => size.kitItemId === selectedItem?.id)
  const [variantId, setVariantId] = useState(String(selectedItem?.variantes[0]?.id ?? ''))
  const [kitSizeId, setKitSizeId] = useState(String(sizes[0]?.id ?? ''))
  const [quantity, setQuantity] = useState('1')
  const [consumptions, setConsumptions] = useState<ConsumoProducao[]>([])
  const [previewing, setPreviewing] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const preview = async (): Promise<void> => {
    setAttempted(true)
    if (!itemId || !validPositive(quantity) || (selectedItem?.tipo === 'KIT' && !kitSizeId)) return
    setPreviewing(true)
    const multiplier = sizes.find((size) => size.id === Number(kitSizeId))?.multiplicador ?? 1
    try { setConsumptions(await window.api.composicao.preverProducao(Number(itemId), numeric(quantity) * multiplier)) }
    finally { setPreviewing(false) }
  }
  const register = async (): Promise<void> => {
    if (!itemId || !consumptions.length) return
    await run(() => window.api.composicao.registrarLote({ itemId: Number(itemId), variantId: variantId ? Number(variantId) : null, kitSizeId: kitSizeId ? Number(kitSizeId) : null, quantidade: numeric(quantity), produzidoEm: Date.now(), consumos: consumptions.map((item) => ({ itemId: item.itemId, variantId: item.varianteId, quantidade: item.quantidade })) }))
    setConsumptions([])
  }
  const total = consumptions.reduce((sum, item) => sum + (item.custoTotal ?? 0), 0)
  return <><section className="bloco"><h3>Registrar produção</h3><div className="form-linha"><select className={attempted && !itemId ? 'invalid' : ''} value={itemId} onChange={(e) => { const item = producible.find((candidate) => candidate.id === Number(e.target.value)); const itemSizes = summary.tamanhosKit.filter((size) => size.kitItemId === item?.id); setItemId(e.target.value); setVariantId(String(item?.variantes[0]?.id ?? '')); setKitSizeId(String(itemSizes[0]?.id ?? '')); setConsumptions([]) }}><option value="">O que foi produzido *…</option>{producible.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}</select><select value={variantId} onChange={(e) => { setVariantId(e.target.value); setConsumptions([]) }}>{selectedItem?.variantes.map((variant) => <option key={variant.id} value={variant.id}>{variant.nome}</option>)}</select>{selectedItem?.tipo === 'KIT' && <select className={attempted && !kitSizeId ? 'invalid' : ''} value={kitSizeId} onChange={(e) => { setKitSizeId(e.target.value); setConsumptions([]) }}><option value="">Tamanho *</option>{sizes.map((size) => <option key={size.id} value={size.id}>{size.totalCaixas} caixas</option>)}</select>}<input className={`curto ${attempted && !validPositive(quantity) ? 'invalid' : ''}`} placeholder="Nº de kits/lotes *" title="Quantidade de unidades produzidas" value={quantity} onChange={(e) => { setQuantity(e.target.value); setConsumptions([]) }} /><button onClick={() => void preview()} disabled={previewing}>{previewing ? 'Calculando…' : 'Calcular materiais'}</button></div>
    {!!consumptions.length && <><table className="tabela"><thead><tr><th>Material efetivamente usado</th><th>Versão</th><th className="num">Quantidade</th><th className="num">Em estoque</th><th className="num">Custo</th></tr></thead><tbody>{consumptions.map((consumption, index) => { const item = summary.itens.find((candidate) => candidate.id === consumption.itemId); return <tr key={consumption.itemId}><td>{consumption.itemNome}</td><td><select value={consumption.varianteId ?? ''} onChange={(e) => { const variantId = e.target.value ? Number(e.target.value) : null; const unitCost = item?.variantes.find((variant) => variant.id === variantId)?.custoMedio ?? item?.custoReferencia ?? null; setConsumptions(consumptions.map((value, current) => current === index ? { ...value, varianteId: variantId, custoUnitario: unitCost, custoTotal: unitCost === null ? null : unitCost * value.quantidade } : value)) }}>{item?.variantes.map((variant) => <option key={variant.id} value={variant.id}>{variant.nome}</option>)}</select></td><td className="num"><input className="curto" value={String(consumption.quantidade).replace('.', ',')} onChange={(e) => { const amount = numeric(e.target.value); setConsumptions(consumptions.map((value, current) => current === index ? { ...value, quantidade: amount, custoTotal: value.custoUnitario === null ? null : amount * value.custoUnitario } : value)) }} /> {consumption.unidade}</td><td className="num">{consumption.estoque.toLocaleString('pt-BR')} {consumption.unidade}</td><td className="num">{money(consumption.custoTotal)}</td></tr> })}</tbody></table><div className="form-linha"><b>Custo real deste lote: {money(total)}</b><button className="primario" onClick={() => void register()}>Registrar lote e baixar materiais</button></div></>}</section>
    <table className="tabela"><thead><tr><th>Data</th><th>Produzido</th><th>Tema/versão</th><th className="num">Quantidade</th><th className="num">Estimado/un.</th><th className="num">Real/un.</th><th className="num">Custo real</th></tr></thead><tbody>{summary.lotes.map((lot) => <tr key={lot.id}><td>{new Date(lot.produzidoEm).toLocaleDateString('pt-BR')}</td><td>{lot.itemNome}{lot.totalCaixas && <small className="muted"> · {lot.totalCaixas} caixas</small>}</td><td>{lot.varianteNome ?? '—'}</td><td className="num">{lot.quantidade.toLocaleString('pt-BR')}</td><td className="num">{money(lot.custoUnitarioEstimado)}</td><td className="num">{money(lot.custoUnitarioReal)}</td><td className="num">{money(lot.custoReal)}</td></tr>)}</tbody></table></>
}

function StockTab({ summary, run }: { summary: ResumoComposicao; run: Run }): React.JSX.Element {
  const [adjustment, setAdjustment] = useState<{ itemId: number; variantId: number; quantidade: string; observacao: string } | null>(null)
  const adjust = async (): Promise<void> => {
    if (!adjustment) return
    const amount = numeric(adjustment.quantidade)
    if (!Number.isFinite(amount) || amount === 0) return
    await run(() => window.api.composicao.ajustarEstoque({ itemId: adjustment.itemId, variantId: adjustment.variantId, quantidade: amount, observacao: adjustment.observacao || 'Ajuste manual' }))
    setAdjustment(null)
  }
  return <>{adjustment && <div className="composicao-editor-inline"><b>Ajustar estoque</b><input value={adjustment.quantidade} onChange={(e) => setAdjustment({ ...adjustment, quantidade: e.target.value })} placeholder="Quantidade (+ entrada, − saída)" autoFocus /><input value={adjustment.observacao} onChange={(e) => setAdjustment({ ...adjustment, observacao: e.target.value })} placeholder="Motivo" /><button className="primario" onClick={() => void adjust()}>Salvar</button><button onClick={() => setAdjustment(null)}>Cancelar</button></div>}<table className="tabela"><thead><tr><th>Item</th><th>Versão</th><th className="num">Saldo</th><th className="num">Custo médio</th><th></th></tr></thead><tbody>{summary.itens.filter((item) => item.controlaEstoque).flatMap((item) => item.variantes.map((variant) => <tr key={variant.id}><td>{item.nome}</td><td>{variant.nome}</td><td className="num">{variant.estoque.toLocaleString('pt-BR')} {item.unidade}</td><td className="num">{money(variant.custoMedio)}</td><td className="acoes"><button onClick={() => setAdjustment({ itemId: item.id, variantId: variant.id, quantidade: '', observacao: '' })}>Ajustar</button></td></tr>))}</tbody></table>
    <h3>Movimentos recentes</h3><table className="tabela"><thead><tr><th>Data</th><th>Item</th><th>Versão</th><th>Motivo</th><th className="num">Movimento</th></tr></thead><tbody>{summary.movimentos.map((move) => <tr key={move.id}><td>{new Date(move.aconteceuEm).toLocaleString('pt-BR')}</td><td>{move.itemNome}</td><td>{move.varianteNome ?? '—'}</td><td>{move.motivo.replaceAll('_', ' ').toLowerCase()}</td><td className="num">{move.quantidade > 0 ? '+' : ''}{move.quantidade.toLocaleString('pt-BR')} {move.unidade}</td></tr>)}</tbody></table></>
}
