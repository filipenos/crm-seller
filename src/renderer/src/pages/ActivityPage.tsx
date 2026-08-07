import { useEffect, useState } from 'react'
import type { OrderEvent, OrderEventSource } from '@shared/types'

interface Props {
  dataVersion: number
  onSeen: () => void
}

const SOURCE_META: Record<OrderEventSource, { icon: string; label: string }> = {
  logistics: { icon: '🚚', label: 'Rastreio' },
  rating: { icon: '⭐', label: 'Avaliação' },
  finance: { icon: '💰', label: 'Pagamento' },
  status: { icon: '📋', label: 'Status' }
}

export default function ActivityPage({ dataVersion, onSeen }: Props): React.JSX.Element {
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [onlyUnseen, setOnlyUnseen] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<OrderEventSource | 'todos'>('todos')

  useEffect(() => {
    void window.api.events.list({ onlyUnseen, limit: 300 }).then(setEvents)
  }, [dataVersion, onlyUnseen])

  const filtered =
    sourceFilter === 'todos' ? events : events.filter((e) => e.source === sourceFilter)

  const byDay = new Map<string, OrderEvent[]>()
  for (const e of filtered) {
    const day = new Date(e.happenedAt).toLocaleDateString('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: 'long'
    })
    const list = byDay.get(day) ?? []
    list.push(e)
    byDay.set(day, list)
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Atividade</h1>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={onlyUnseen}
            onChange={(e) => setOnlyUnseen(e.target.checked)}
          />
          só não vistos
        </label>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as OrderEventSource | 'todos')}
        >
          <option value="todos">Todos os tipos</option>
          <option value="logistics">🚚 Rastreio</option>
          <option value="rating">⭐ Avaliações</option>
          <option value="finance">💰 Pagamentos</option>
        </select>
        <button
          className="mark-seen-btn"
          onClick={async () => {
            await window.api.events.markAllSeen()
            setEvents(await window.api.events.list({ onlyUnseen, limit: 300 }))
            onSeen()
          }}
        >
          ✓ Marcar tudo como visto
        </button>
      </header>

      {filtered.length === 0 ? (
        <div className="empty">
          Nenhum evento{onlyUnseen ? ' não visto' : ''} ainda. Os eventos aparecem conforme a
          sincronização encontra novidades de rastreio, avaliações e pagamentos.
        </div>
      ) : (
        [...byDay.entries()].map(([day, dayEvents]) => (
          <div key={day} className="event-day">
            <h3 className="event-day-title">{day}</h3>
            {dayEvents.map((e) => (
              <div key={e.eventKey} className={`event-row ${e.seen ? '' : 'unseen'}`}>
                <span className="event-icon" title={SOURCE_META[e.source].label}>
                  {SOURCE_META[e.source].icon}
                </span>
                <div className="event-body">
                  <div className="event-desc">{e.description}</div>
                  <div className="event-meta">
                    <span className="mono">{e.orderSn}</span> ·{' '}
                    {new Date(e.happenedAt).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}
