import { useEffect, useMemo, useState } from 'react'
import type { AgendaDia, AgendaQuantidade, AgendaTrabalho } from '@shared/types'
import { INTERNAL_STATUS_LABELS } from '@shared/types'
import { dashboardDates } from '@shared/dashboardDays'
import { searchWorkOrders } from '@shared/workSearch'
import OrderDetail from '../components/OrderDetail'

interface Props { dataVersion: number }

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

export default function WorkPage({ dataVersion }: Props): React.JSX.Element {
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
  const searching = search.trim().length > 0
  const results = useMemo(() => agenda ? searchWorkOrders(agenda, search, hideDone) : [], [agenda, search, hideDone])

  return <div className="page work-page">
    <header className="page-header"><div><h1>Meu trabalho</h1><p className="muted">Produção organizada pelo prazo interno de postagem</p></div></header>
    <div className="work-toolbar"><label htmlFor="work-days">Próximos dias</label>
      <select id="work-days" value={days} onChange={(event) => { setDays(Number(event.target.value)); setExpanded(null) }}>
        {Array.from({ length: 10 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </select><span className="muted">incluindo hoje</span>
      <label className="work-hide-done"><input type="checkbox" checked={hideDone} onChange={(event) => setHideDone(event.target.checked)} /> Ocultar já feitos</label>
    </div>
    <div className="work-search"><label htmlFor="work-search">Pesquisar pedidos</label><div><input id="work-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ID, usuário, criança, produto ou variação" /><span className="muted">Agenda dos próximos {days} dias e pedidos etiquetados para entregar</span></div></div>
    <div className="work-tip">Prazo interno: 1 dia antes da Shopee
      <span className="work-tip-icon" tabIndex={0} aria-label="Como calculamos o prazo interno">ⓘ
        <span role="tooltip">A agenda usa “Postar até” da Shopee menos um dia para antecipar a produção. O prazo original aparece em cada dia.</span>
      </span>
    </div>
    {loading && <div className="empty loading-indicator">Carregando agenda…</div>}
    {error && <div className="aviso alerta">Não foi possível carregar a agenda: {error}</div>}
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
        <section className="work-today-card"><h2>Etiquetados para entregar</h2><strong>{agenda.paraEntregar.length} {agenda.paraEntregar.length === 1 ? 'pedido' : 'pedidos'}</strong>
          <p>Etiquetas de hoje: {labeledToday.length} · Anteriores ou sem data: {labeledEarlier}</p>
          {agenda.paraEntregar.length > 0 && <button className="work-expand" type="button" aria-expanded={showDeliveries} onClick={() => setShowDeliveries(!showDeliveries)}>{showDeliveries ? 'Ocultar pedidos' : 'Ver pedidos'} →</button>}
          {showDeliveries && <div className="work-orders">{agenda.paraEntregar.map((order) => <button type="button" key={order.orderSn} onClick={() => setSelected(order.orderSn)}><span className="mono">{orderLabel(order.orderSn, order.buyerUsername)}</span><small>Etiqueta: {order.etiquetaEm ? new Date(order.etiquetaEm).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'data não informada'}{order.postarAte ? ` · Postar até ${new Date(order.postarAte).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : ''}</small></button>)}</div>}
        </section>
      </div>
      <div className="work-stats">
        <div><small>{hideDone ? 'Pedidos por fazer' : 'Pedidos no período'}</small><strong>{hideDone ? orders - doneOrders : orders}</strong>{!hideDone && <span>{doneOrders} feitos · {orders - doneOrders} por fazer</span>}</div>
        <div><small>Laços necessários</small><strong>{total(bows).toLocaleString('pt-BR')}</strong><span>{bows.length} cores</span></div>
        <div><small>Caixas necessárias</small><strong>{total(boxes).toLocaleString('pt-BR')}</strong><span>{boxes.length} modelos</span></div>
      </div>
      <div className="work-section-head"><h2>Agenda de produção</h2><span>{displayDate(agenda.hoje)} a {displayDate(agenda.dias.at(-1)?.data ?? agenda.hoje)}</span></div>
      <div className="work-days">{agenda.dias.filter((day) => !hideDone || day.pedidos.length > day.pedidosFeitos).map((day) => {
        const visibleOrders = hideDone ? day.pedidos.filter((order) => !order.feito) : day.pedidos
        const pending = visibleOrders.filter((order) => order.pendencias.length > 0).length
        return <article className={`work-day ${day.data === agenda.hoje ? 'today' : ''}`} key={day.data}>
          <div className="work-day-head"><h3>{day.data === agenda.hoje ? 'Hoje' : displayDay(day.data)}</h3>
            <span>{hideDone ? pedidosLabel(visibleOrders.length) + ' por fazer' : `${pedidosLabel(day.pedidos.length)} · ${day.pedidosFeitos} feitos · ${day.pedidos.length - day.pedidosFeitos} por fazer`}</span>
            <span>Shopee: postar até {displayDate(day.postarAte)}</span>
          </div>
          <div className="work-day-group"><b>Laços · {pedidosLabel(hideDone ? day.pedidosLacos - day.pedidosLacosFeitos : day.pedidosLacos)} · {hideDone ? total(day.lacos) : total(day.lacos) + day.lacosFeitos} laços</b>{!hideDone && <span>{day.pedidosLacosFeitos} pedidos e {day.lacosFeitos} laços feitos · {total(day.lacos)} laços por fazer</span>}<span>{day.lacos.length ? day.lacos.map((item) => `${item.nome} ${item.quantidade}`).join(' · ') : 'Nenhum laço pendente'}</span></div>
          <div className="work-day-group"><b>Caixas · {pedidosLabel(hideDone ? day.pedidosCaixas - day.pedidosCaixasFeitos : day.pedidosCaixas)} · {hideDone ? total(day.caixas) : total(day.caixas) + day.caixasFeitas} caixas</b>{!hideDone && <span>{day.pedidosCaixasFeitos} pedidos e {day.caixasFeitas} caixas feitas · {total(day.caixas)} caixas por fazer</span>}<span>{day.caixas.length ? day.caixas.map((item) => `${item.nome} ${item.quantidade}`).join(' · ') : 'Nenhuma caixa pendente'}</span></div>
          {pending > 0 && <div className="work-pending">{pending} pedido(s) precisam de dados para calcular a produção</div>}
          {visibleOrders.length > 0 && <button className="work-expand" type="button" aria-expanded={expanded === day.data}
            onClick={() => setExpanded(expanded === day.data ? null : day.data)}>
            {expanded === day.data ? 'Ocultar pedidos' : 'Ver pedidos e detalhes'} →
          </button>}
          {expanded === day.data && <div className="work-orders">{visibleOrders.map((order) =>
            <button type="button" key={order.orderSn} onClick={() => setSelected(order.orderSn)}>
              <span className="mono">{orderLabel(order.orderSn, order.buyerUsername)}</span><small>Entrada: {order.createdAtShopee ? new Date(order.createdAtShopee).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }) : 'não informada'} · {INTERNAL_STATUS_LABELS[order.status]}{order.feito ? ' · etiqueta gerada' : order.embalado ? ' · embalado' : ''}</small>
              {order.itens.map((item, index) => <small key={index}>{item}</small>)}
              {order.pendencias.map((item, index) => <small className="work-pending" key={index}>{item}</small>)}
            </button>)}
          </div>}
        </article>
      })}</div>
      {hideDone && agenda.dias.every((day) => day.pedidos.length === day.pedidosFeitos) && <div className="empty">Nenhum pedido por fazer neste período.</div>}
      <div className="work-summaries"><Summary title="Laços por cor" items={bows} /><Summary title="Caixas por modelo" items={boxes} /></div>
      <p className="muted small">“Feito” significa etiqueta gerada, mesmo que a postagem ainda esteja pendente. As listas por cor e modelo mostram o que falta fazer, sem descontar estoque ou lotes já produzidos.</p>
    </>}
    {toast && <div className="toast">{toast}</div>}
    {selected && <OrderDetail orderSn={selected} onClose={() => setSelected(null)}
      onOrderChange={() => setRefresh((value) => value + 1)} onToast={setToast} />}
  </div>
}
