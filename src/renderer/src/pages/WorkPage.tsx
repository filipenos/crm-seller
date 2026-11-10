import { useEffect, useMemo, useState } from 'react'
import type { AgendaDia, AgendaQuantidade, AgendaTrabalho } from '@shared/types'
import { INTERNAL_STATUS_LABELS } from '@shared/types'
import { dashboardDates } from '@shared/dashboardDays'
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

  return <div className="page work-page">
    <header className="page-header"><div><h1>Meu trabalho</h1><p className="muted">Produção organizada pelo prazo interno de postagem</p></div></header>
    <div className="work-toolbar"><label htmlFor="work-days">Próximos dias</label>
      <select id="work-days" value={days} onChange={(event) => { setDays(Number(event.target.value)); setExpanded(null) }}>
        {Array.from({ length: 10 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </select><span className="muted">incluindo hoje</span>
    </div>
    <div className="work-tip">Prazo interno: 1 dia antes da Shopee
      <span className="work-tip-icon" tabIndex={0} aria-label="Como calculamos o prazo interno">ⓘ
        <span role="tooltip">A agenda usa “Postar até” da Shopee menos um dia para antecipar a produção. O prazo original aparece em cada dia.</span>
      </span>
    </div>
    {loading && <div className="empty loading-indicator">Carregando agenda…</div>}
    {error && <div className="aviso alerta">Não foi possível carregar a agenda: {error}</div>}
    {!loading && agenda && <>
      {(agenda.atrasados > 0 || agenda.semPrazo > 0) && <div className="work-alert">
        {agenda.atrasados > 0 && <span>{agenda.atrasados} pedido(s) com prazo interno vencido.</span>}
        {agenda.semPrazo > 0 && <span>{agenda.semPrazo} pedido(s) sem prazo da Shopee.</span>}
        <span>Consulte a tela de Pedidos para tratar esses casos.</span>
      </div>}
      <div className="work-stats">
        <div><small>Pedidos no período</small><strong>{orders}</strong><span>a enviar</span></div>
        <div><small>Laços necessários</small><strong>{total(bows).toLocaleString('pt-BR')}</strong><span>{bows.length} cores</span></div>
        <div><small>Caixas necessárias</small><strong>{total(boxes).toLocaleString('pt-BR')}</strong><span>{boxes.length} modelos</span></div>
      </div>
      <div className="work-section-head"><h2>Agenda de produção</h2><span>{displayDate(agenda.hoje)} a {displayDate(agenda.dias.at(-1)?.data ?? agenda.hoje)}</span></div>
      <div className="work-days">{agenda.dias.map((day) => {
        const pending = day.pedidos.filter((order) => order.pendencias.length > 0).length
        return <article className={`work-day ${day.data === agenda.hoje ? 'today' : ''}`} key={day.data}>
          <div className="work-day-head"><h3>{day.data === agenda.hoje ? 'Hoje' : displayDay(day.data)}</h3>
            <span>{day.pedidos.length} {day.pedidos.length === 1 ? 'pedido' : 'pedidos'} · Shopee: postar até {displayDate(day.postarAte)}</span>
          </div>
          <div className="work-day-group"><b>Laços · {pedidosLabel(day.pedidosLacos)} · {total(day.lacos).toLocaleString('pt-BR')} laços</b><span>{day.lacos.length ? day.lacos.map((item) => `${item.nome} ${item.quantidade}`).join(' · ') : 'Nenhum'}</span></div>
          <div className="work-day-group"><b>Caixas · {pedidosLabel(day.pedidosCaixas)} · {total(day.caixas).toLocaleString('pt-BR')} caixas</b><span>{day.caixas.length ? day.caixas.map((item) => `${item.nome} ${item.quantidade}`).join(' · ') : 'Nenhuma'}</span></div>
          {pending > 0 && <div className="work-pending">{pending} pedido(s) precisam de dados para calcular a produção</div>}
          {day.pedidos.length > 0 && <button className="work-expand" type="button" aria-expanded={expanded === day.data}
            onClick={() => setExpanded(expanded === day.data ? null : day.data)}>
            {expanded === day.data ? 'Ocultar pedidos' : 'Ver pedidos e detalhes'} →
          </button>}
          {expanded === day.data && <div className="work-orders">{day.pedidos.map((order) =>
            <button type="button" key={order.orderSn} onClick={() => setSelected(order.orderSn)}>
              <span className="mono">{order.orderSn}</span><small>{INTERNAL_STATUS_LABELS[order.status]}{order.embalado ? ' · embalado' : ''}</small>
              {order.itens.map((item, index) => <small key={index}>{item}</small>)}
              {order.pendencias.map((item, index) => <small className="work-pending" key={index}>{item}</small>)}
            </button>)}
          </div>}
        </article>
      })}</div>
      <div className="work-summaries"><Summary title="Laços por cor" items={bows} /><Summary title="Caixas por modelo" items={boxes} /></div>
      <p className="muted small">Laços por cor incluem os kits de laços; caixas incluem os kits de caixas. Quantidades dos pedidos ainda não embalados, sem descontar estoque ou lotes já produzidos.</p>
    </>}
    {toast && <div className="toast">{toast}</div>}
    {selected && <OrderDetail orderSn={selected} onClose={() => setSelected(null)}
      onOrderChange={() => setRefresh((value) => value + 1)} onToast={setToast} />}
  </div>
}
