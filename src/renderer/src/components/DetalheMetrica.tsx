import { useEffect, useState } from 'react'
import type { MetricaPainel, SerieMensal } from '@shared/types'
import { METRICA_LABELS, METRICAS_EM_REAIS } from '@shared/types'

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const MESES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro'
]

interface Props {
  metrica: MetricaPainel
  onClose: () => void
}

/**
 * Detalhe diário de uma métrica, mês a mês.
 *
 * O número do dia sozinho não diz se foi um bom dia — só comparado com os
 * vizinhos. Daí o gráfico por dia, com o valor de cada barra à mostra e
 * navegação entre meses.
 */
export default function DetalheMetrica({ metrica, onClose }: Props): React.JSX.Element {
  const hoje = new Date()
  const [ano, setAno] = useState(hoje.getFullYear())
  const [mes, setMes] = useState(hoje.getMonth() + 1)
  const [serie, setSerie] = useState<SerieMensal | null>(null)

  useEffect(() => {
    void window.api.painel.serie(metrica, ano, mes).then(setSerie)
  }, [metrica, ano, mes])

  const navega = (delta: number): void => {
    const d = new Date(ano, mes - 1 + delta, 1)
    setAno(d.getFullYear())
    setMes(d.getMonth() + 1)
  }

  const emReais = METRICAS_EM_REAIS.includes(metrica)
  const formata = (v: number): string => (emReais ? BRL.format(v) : String(v))
  const maior = serie ? Math.max(...serie.dias.map((d) => d.valor), 1) : 1
  const diaDeHoje =
    hoje.getFullYear() === ano && hoje.getMonth() + 1 === mes ? hoje.getDate() : null
  const comMovimento = serie?.dias.filter((d) => d.valor > 0).length ?? 0

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer drawer-largo">
        <header className="drawer-header">
          <div>
            <h2>{METRICA_LABELS[metrica]}</h2>
            <div className="muted">
              {serie ? `${formata(serie.total)} no mês · ${comMovimento} dias com movimento` : '…'}
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="mes-nav">
          <button onClick={() => navega(-1)}>‹</button>
          <span>
            {MESES[mes - 1]} {ano}
          </span>
          <button onClick={() => navega(1)} disabled={ano === hoje.getFullYear() && mes === hoje.getMonth() + 1}>
            ›
          </button>
        </div>

        {serie && (
          <div className="grafico-dias">
            {serie.dias.map((d) => (
              <div
                key={d.dia}
                className={`coluna-dia ${d.dia === diaDeHoje ? 'hoje' : ''}`}
                title={`Dia ${d.dia}: ${formata(d.valor)}`}
              >
                <div className="valor-dia">{d.valor > 0 ? formata(d.valor) : ''}</div>
                <div className="trilho-dia">
                  <div
                    className="barra-dia"
                    style={{ height: `${d.valor > 0 ? Math.max(4, (d.valor / maior) * 100) : 0}%` }}
                  />
                </div>
                <div className="rotulo-dia">{d.dia}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
