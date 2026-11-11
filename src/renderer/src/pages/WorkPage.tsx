import { useEffect, useMemo, useState } from 'react'
import type { AgendaDia, AgendaQuantidade, AgendaTrabalho, TrabalhoAtualPedido } from '@shared/types'
import { dashboardDates } from '@shared/dashboardDays'
import { searchWorkOrders } from '@shared/workSearch'
import { filterWorkDayOrders, visibleWorkColors, type DayFilter } from '@shared/workFilters'
import OrderDetail from '../components/OrderDetail'

interface Props { dataVersion: number; onEditArt: (orderSn: string) => void }

const DATE = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })
const SHORT_DATE = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })

function displayDay(day: string): string {
  return DATE.format(new Date(`${day}T12:00:00-03:00`))
}

function displayDate(day: string): string {
  return SHORT_DATE.format(new Date(`${day}T12:00:00-03:00`))
}

function total(items: AgendaQuantidade[]): number {
  return items.reduce((sum, item) => sum + item.quantidade, 0)
}

function pedidosLabel(count: number): string {
  return `${count} ${count === 1 ? 'pedido' : 'pedidos'}`
}

function orderLabel(orderSn: string, buyerUsername: string | null): string {
  return buyerUsername ? `${orderSn} (${buyerUsername})` : orderSn
}

function summarize(days: AgendaDia[], key: 'lacos' | 'caixas'): AgendaQuantidade[] {
  const values = new Map<string, number>()
  for (const day of days) {
    for (const item of day[key]) values.set(item.nome, (values.get(item.nome) ?? 0) + item.quantidade)
  }
  return [...values].map(([nome, quantidade]) => ({ nome, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade || a.nome.localeCompare(b.nome, 'pt-BR'))
}

function Summary({ title, items }: { title: string; items: AgendaQuantidade[] }): React.JSX.Element {
  return <section className="work-summary"><h2>{title}</h2>{items.length === 0
    ? <p className="muted">Nada previsto no período.</p>
    : items.map((item) => <div className="work-summary-row" key={item.nome}>
      <span>{item.nome}</span><b>{item.quantidade.toLocaleString('pt-BR')}</b>
    </div>)}
  </section>
}

export default function WorkPage({ dataVersion, onEditArt }: Props): React.JSX.Element {
  const [days, setDays] = useState(7)
  const [agenda, setAgenda] = useState<AgendaTrabalho | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [dayTick, setDayTick] = useState(0)
  const [hideDone, setHideDone] = useState(false)
  const [showTodayOrders, setShowTodayOrders] = useState(false)
  const [showDeliveries, setShowDeliveries] = useState(false)
  const [search, setSearch] = useState('')
  const [dayFilters, setDayFilters] = useState<Record<string, DayFilter>>({})
  const [selectionBusy, setSelectionBusy] = useState(false)

  async function selectWork(orderSns: string[], selected: boolean): Promise<void> {
    if (!agenda || selectionBusy || orderSns.length === 0) return
    const selectedIds = new Set(agenda.selecionados.map((order) => order.orderSn))
    const changedIds = orderSns.filter((orderSn) => selected ? !selectedIds.has(orderSn) : selectedIds.has(orderSn))
    if (changedIds.length === 0) return
    setSelectionBusy(true)
    try {
      const changed = await window.api.trabalho.selecionar(changedIds, selected)
      if (changed !== changedIds.length) {
        setToast('Alguns pedidos mudaram de situação. Atualizando o trabalho atual.')
        setRefresh((value) => value + 1)
        return
      }
      setAgenda((current) => {
        if (!current) return current
        if (!selected) return { ...current, selecionados: current.selecionados.filter((order) => !changedIds.includes(order.orderSn)) }
        const additions: TrabalhoAtualPedido[] = current.dias.flatMap((day) => day.pedidos
          .filter((order) => changedIds.includes(order.orderSn))
          .map((order) => ({ ...order, prazoInterno: day.data, postarAte: Date.parse(`${day.postarAte}T12:00:00-03:00`) })))
        return { ...current, selecionados: [...current.selecionados, ...additions]
          .sort((a, b) => (a.prazoInterno ?? '9999').localeCompare(b.prazoInterno ?? '9999') || (a.createdAtShopee ?? Infinity) - (b.createdAtShopee ?? Infinity)) }
      })
    } catch {
      setToast('Não foi possível atualizar o trabalho atual. Tente novamente.')
    } finally {
      setSelectionBusy(false)
    }
  }

  function changeDayFilter(day: string, change: DayFilter): void {
    setDayFilters((current) => ({ ...current, [day]: { ...current[day], ...change } }))
    setExpanded(day)
  }

  useEffect(() => {
    const nextMidnight = dashboardDates().bounds[2]
    const timer = setTimeout(() => setDayTick((value) => value + 1), Math.max(1000, nextMidnight - Date.now() + 1000))
    return () => clearTimeout(timer)
  }, [dayTick])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setAgenda(null)
    void window.api.trabalho.agenda(days)
      .then((result) => { if (active) setAgenda(result) })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [days, dataVersion, refresh, dayTick])

  const bows = useMemo(() => summarize(agenda?.dias ?? [], 'lacos'), [agenda])
  const boxes = useMemo(() => summarize(agenda?.dias ?? [], 'caixas'), [agenda])
  const orders = agenda?.dias.reduce((sum, day) => sum + day.pedidos.length, 0) ?? 0
  const doneOrders = agenda?.dias.reduce((sum, day) => sum + day.pedidosFeitos, 0) ?? 0
  const todayWork = agenda?.dias[0]
  const todayPending = todayWork?.pedidos.filter((order) => !order.feito) ?? []
  const labeledToday = agenda?.paraEntregar.filter((order) => order.etiquetaEm !== null && order.etiquetaEm >= dashboardDates().bounds[1] && order.etiquetaEm < dashboardDates().bounds[2]) ?? []
  const labeledEarlier = (agenda?.paraEntregar.length ?? 0) - labeledToday.length
  const deliveries = hideDone ? [] : agenda?.paraEntregar ?? []
  const searching = search.trim().length > 0
  const results = useMemo(() => agenda ? searchWorkOrders(agenda, search, hideDone) : [], [agenda, search, hideDone])

  return <div className="page work-page">
    <header className="page-header"><div><h1>Meu trabalho</h1><p className="muted">Produção organizada pelo prazo interno de postagem</p></div></header>
    <div className="work-toolbar"><label htmlFor="work-days">Próximos dias</label>
      <select id="work-days" value={days} onChange={(event) => { setDays(Number(event.target.value)); setExpanded(null) }}>
        {Array.from({ length: 10 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </select><span className="muted">incluindo hoje</span>
      <label className="work-hide-done"><input type="checkbox" checked={hideDone} onChange={(event) => { setHideDone(event.target.checked); setDayFilters({}) }} /> Ocultar já feitos</label>
    </div>
    <div className="work-search"><label htmlFor="work-search">Pesquisar pedidos</label><div><input id="work-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ID, usuário, criança, produto ou variação" /><span className="muted">Agenda dos próximos {days} dias e pedidos etiquetados para entregar</span></div></div>
    <div className="work-tip">Prazo interno: 1 dia antes da Shopee
      <span className="work-tip-icon" tabIndex={0} aria-label="Como calculamos o prazo interno">ⓘ
        <span role="tooltip">A agenda usa “Postar até” da Shopee menos um dia para antecipar a produção. O prazo original aparece em cada dia.</span>
      </span>
    </div>
    {loading && <div className="empty loading-indicator">Carregando agenda…</div>}
    {error && <div className="aviso alerta">Não foi possível carregar a agenda: {error}</div>}
    {!loading && agenda && <section className="work-current">
      <div className="work-section-head"><h2>Estou fazendo</h2><span>{pedidosLabel(agenda.selecionados.length)} escolhidos</span></div>
      <p className="muted small">Escolha um dia inteiro ou pedidos avulsos na agenda. Eles continuam aqui mesmo se você mudar o período.</p>
      {agenda.selecionados.length === 0 ? <p className="muted">Nenhum pedido selecionado para o trabalho atual.</p> :
        <div className="work-current-list">{agenda.selecionados.map((order) => <div className="work-current-order" key={order.orderSn}>
          <button type="button" className="work-current-open" onClick={() => setSelected(order.orderSn)}><strong>{orderLabel(order.orderSn, order.buyerUsername)}</strong><small>Prazo interno: {order.prazoInterno ? displayDate(order.prazoInterno) : 'sem prazo'}{order.childName ? ` · Criança: ${order.childName}` : ''}</small><small>{order.itens.join(' · ') || 'Pedido sem itens'}</small></button>
          <button type="button" className="work-select-button" disabled={selectionBusy} onClick={() => void selectWork([order.orderSn], false)}>Remover</button>
        </div>)}</div>}
    </section>}
    {!loading && agenda && searching && <section className="work-search-results"><h2>{results.length} {results.length === 1 ? 'pedido encontrado' : 'pedidos encontrados'}</h2>
      {results.length === 0 ? <p className="muted">Nenhum pedido corresponde à pesquisa neste período.</p> : <div className="work-orders">{results.map((order) => <button type="button" key={order.orderSn} onClick={() => setSelected(order.orderSn)}><span className="mono">{orderLabel(order.orderSn, order.buyerUsername)}</span><small>{order.origem === 'entrega' ? 'Etiquetado para entregar' : `Produção · ${displayDate(order.data ?? agenda.hoje)}`} · Postar até {order.postarAte ? new Date(order.postarAte).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'sem prazo'}{order.childName ? ` · Criança: ${order.childName}` : ''}</small>{order.itens.map((item, index) => <small key={index}>{item}</small>)}</button>)}</div>}
    </section>}
    {!loading && agenda && !searching && <>
      {(agenda.atrasados > 0 || agenda.semPrazo > 0) && <div className="work-alert">
        {agenda.atrasados > 0 && <span>{agenda.atrasados} pedido(s) com prazo interno vencido.</span>}
        {agenda.semPrazo > 0 && <span>{agenda.semPrazo} pedido(s) sem prazo da Shopee.</span>}
        <span>Consulte a tela de Pedidos para tratar esses casos.</span>
      </div>}
      <div className="work-today">
        <section className="work-today-card"><h2>Para fazer hoje</h2><strong>{todayPending.length} {todayPending.length === 1 ? 'pedido' : 'pedidos'}</strong>
          <p>{total(todayWork?.lacos ?? []).toLocaleString('pt-BR')} laços · {total(todayWork?.caixas ?? []).toLocaleString('pt-BR')} caixas</p>
          {todayPending.length > 0 && <button className="work-expand" type="button" aria-expanded={showTodayOrders} onClick={() => setShowTodayOrders(!showTodayOrders)}>{showTodayOrders ? 'Ocultar pedidos' : 'Ver pedidos'} →</button>}
          {showTodayOrders && <div className="work-orders">{todayPending.map((order) => <button type="button" key={order.orderSn} onClick={() => setSelected(order.orderSn)}><span className="mono">{orderLabel(order.orderSn, order.buyerUsername)}</span><small>{order.itens.join(' · ')}</small></button>)}</div>}
        </section>
        <section className="work-today-card"><h2>Etiquetados para entregar</h2><strong>{deliveries.length} {deliveries.length === 1 ? 'pedido' : 'pedidos'}</strong>
          <p>{hideDone ? 'Ocultos enquanto “Ocultar já feitos” estiver ativo.' : `Etiquetas de hoje: ${labeledToday.length} · Anteriores ou sem data: ${labeledEarlier}`}</p>
          {deliveries.length > 0 && <button className="work-expand" type="button" aria-expanded={showDeliveries} onClick={() => setShowDeliveries(!showDeliveries)}>{showDeliveries ? 'Ocultar pedidos' : 'Ver pedidos'} →</button>}
          {showDeliveries && <div className="work-orders">{deliveries.map((order) => <button type="button" key={order.orderSn} onClick={() => setSelected(order.orderSn)}><span className="mono">{orderLabel(order.orderSn, order.buyerUsername)}</span><small>Etiqueta: {order.etiquetaEm ? new Date(order.etiquetaEm).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'data não informada'}{order.postarAte ? ` · Postar até ${new Date(order.postarAte).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : ''}</small></button>)}</div>}
        </section>
      </div>
      <div className="work-stats">
        <div><small>{hideDone ? 'Pedidos por fazer' : 'Pedidos no período'}</small><strong>{hideDone ? orders - doneOrders : orders}</strong>{!hideDone && <span>{doneOrders} feitos · {orders - doneOrders} por fazer</span>}</div>
        <div><small>Laços necessários</small><strong>{total(bows).toLocaleString('pt-BR')}</strong><span>{bows.length} cores</span></div>
        <div><small>Caixas necessárias</small><strong>{total(boxes).toLocaleString('pt-BR')}</strong><span>{boxes.length} modelos</span></div>
      </div>
      <div className="work-section-head"><h2>Agenda de produção</h2><span>{displayDate(agenda.hoje)} a {displayDate(agenda.dias.at(-1)?.data ?? agenda.hoje)}</span></div>
      <div className="work-days">{agenda.dias.filter((day) => !hideDone || Object.keys(dayFilters[day.data] ?? {}).length > 0 || day.pedidos.length > day.pedidosFeitos).map((day) => {
        const filter = dayFilters[day.data] ?? {}
        const visibleOrders = filterWorkDayOrders(day.pedidos, filter, hideDone)
        const colors = visibleWorkColors(day, filter, hideDone)
        const pending = visibleOrders.filter((order) => order.pendencias.length > 0).length
        return <article className={`work-day ${day.data === agenda.hoje ? 'today' : ''}`} key={day.data}>
          <div className="work-day-head"><h3>{day.data === agenda.hoje ? 'Hoje' : displayDay(day.data)}</h3>
            <span>{hideDone ? pedidosLabel(visibleOrders.length) + ' por fazer' : `${pedidosLabel(day.pedidos.length)} · ${day.pedidosFeitos} feitos · ${day.pedidos.length - day.pedidosFeitos} por fazer`}</span>
            <span>Shopee: postar até {displayDate(day.postarAte)}</span>
            {day.pedidos.some((order) => !order.feito && !agenda.selecionados.some((selected) => selected.orderSn === order.orderSn)) && <button type="button" className="work-select-button" disabled={selectionBusy} onClick={() => void selectWork(day.pedidos.filter((order) => !order.feito).map((order) => order.orderSn), true)}>Adicionar dia inteiro</button>}
          </div>
          <div className="work-day-group"><button type="button" className={`work-filter-button ${filter.tipo === 'LACOS' && !filter.cor ? 'active' : ''}`} onClick={() => changeDayFilter(day.data, { tipo: 'LACOS', cor: undefined })}>Laços · {pedidosLabel(hideDone ? day.pedidosLacos - day.pedidosLacosFeitos : day.pedidosLacos)} · {hideDone ? total(day.lacos) : total(day.lacos) + day.lacosFeitos} laços</button>{!hideDone && <span>{day.pedidosLacosFeitos} pedidos e {day.lacosFeitos} laços feitos · {total(day.lacos)} laços por fazer</span>}<div className="work-filter-colors">{colors.length ? colors.map((color) => <button type="button" className={`work-filter-button ${filter.cor === color ? 'active' : ''}`} key={color} onClick={() => changeDayFilter(day.data, { tipo: 'LACOS', cor: color })}>{color}{day.lacos.find((item) => item.nome === color)?.quantidade ? ` ${day.lacos.find((item) => item.nome === color)?.quantidade}` : ''}</button>) : <span>Nenhum laço neste dia</span>}</div></div>
          <div className="work-day-group"><button type="button" className={`work-filter-button ${filter.tipo === 'CAIXAS' ? 'active' : ''}`} onClick={() => changeDayFilter(day.data, { tipo: 'CAIXAS', cor: undefined })}>Caixas · {pedidosLabel(hideDone ? day.pedidosCaixas - day.pedidosCaixasFeitos : day.pedidosCaixas)} · {hideDone ? total(day.caixas) : total(day.caixas) + day.caixasFeitas} caixas</button>{!hideDone && <span>{day.pedidosCaixasFeitos} pedidos e {day.caixasFeitas} caixas feitas · {total(day.caixas)} caixas por fazer</span>}<span>{day.caixas.length ? day.caixas.map((item) => `${item.nome} ${item.quantidade}`).join(' · ') : 'Nenhuma caixa pendente'}</span></div>
          <div className="work-day-filters"><span>Mostrar:</span>{(['todos', 'fazer', 'feitos'] as const).map((situacao) => <button type="button" key={situacao} className={`work-filter-button ${(filter.situacao ?? (hideDone ? 'fazer' : 'todos')) === situacao ? 'active' : ''}`} onClick={() => changeDayFilter(day.data, { situacao })}>{situacao === 'todos' ? 'Todos' : situacao === 'fazer' ? 'A fazer' : 'Feitos'}</button>)}{Object.keys(filter).length > 0 && <button type="button" className="work-filter-clear" onClick={() => { setDayFilters((current) => { const next = { ...current }; delete next[day.data]; return next }); setExpanded(day.data) }}>Limpar filtro</button>}</div>
          {pending > 0 && <div className="work-pending">{pending} pedido(s) precisam de dados para calcular a produção</div>}
          <button className="work-expand" type="button" aria-expanded={expanded === day.data}
            onClick={() => setExpanded(expanded === day.data ? null : day.data)}>
            {expanded === day.data ? 'Ocultar pedidos' : 'Ver pedidos e detalhes'} →
          </button>
          {expanded === day.data && <div className="work-orders">{visibleOrders.length === 0 && <p className="muted">Nenhum pedido corresponde ao filtro deste dia.</p>}{visibleOrders.map((order) =>
            <div className="work-agenda-order" key={order.orderSn}><button type="button" onClick={() => setSelected(order.orderSn)}>
              <span className="mono">{orderLabel(order.orderSn, order.buyerUsername)}</span><small>Entrada: {order.createdAtShopee ? new Date(order.createdAtShopee).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }) : 'não informada'} · {order.feito ? 'trabalho feito' : 'produção pendente'}</small>
              {order.itens.map((item, index) => <small key={index}>{item}</small>)}
              {order.pendencias.map((item, index) => <small className="work-pending" key={index}>{item}</small>)}
            </button>{!order.feito && <button type="button" className="work-select-button" disabled={selectionBusy} onClick={() => void selectWork([order.orderSn], !agenda.selecionados.some((selected) => selected.orderSn === order.orderSn))}>{agenda.selecionados.some((selected) => selected.orderSn === order.orderSn) ? 'Remover do trabalho' : 'Adicionar ao trabalho'}</button>}</div>)}
          </div>}
        </article>
      })}</div>
      {hideDone && agenda.dias.every((day) => day.pedidos.length === day.pedidosFeitos) && <div className="empty">Nenhum pedido por fazer neste período.</div>}
      <div className="work-summaries"><Summary title="Laços por cor" items={bows} /><Summary title="Caixas por modelo" items={boxes} /></div>
      <p className="muted small">“Feito” significa etiqueta gerada, mesmo que a postagem ainda esteja pendente. As listas por cor e modelo mostram o que falta fazer, sem descontar estoque ou lotes já produzidos.</p>
    </>}
    {toast && <div className="toast">{toast}</div>}
    {selected && <OrderDetail orderSn={selected} onClose={() => setSelected(null)}
      onOrderChange={() => setRefresh((value) => value + 1)} onToast={setToast}
      onEditArt={(orderSn) => { setSelected(null); onEditArt(orderSn) }} />}
  </div>
}
