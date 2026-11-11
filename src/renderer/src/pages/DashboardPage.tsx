import { useEffect, useState } from 'react'
import type { DiaPainel, Painel, PainelOffsets } from '@shared/types'
import { dashboardDates, DEFAULT_PAINEL_OFFSETS } from '@shared/dashboardDays'
import { api } from '@renderer/api'

interface Props { dataVersion?: number }

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const DAY = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })
const DATE = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' })

function formatDate(day: string): string {
  return DATE.format(new Date(`${day}T12:00:00-03:00`))
}

function FaixaDias({ titulo, descricao, dias, hoje, avisoPrazo, offset, loading, onNavigate }: {
  titulo: string; descricao: string; dias: DiaPainel[]; hoje: string; avisoPrazo?: boolean
  offset: number; loading: boolean; onNavigate: (direction: number) => void
}): React.JSX.Element {
  const pedidos = dias.reduce((sum, dia) => sum + dia.pedidos, 0)
  const total = dias.reduce((sum, dia) => sum + dia.total, 0)
  const liquido = dias.reduce((sum, dia) => sum + dia.liquido, 0)
  const semLiquido = dias.reduce((sum, dia) => sum + dia.semValorLiquido, 0)
  return <section className="painel-faixa">
    <div className="painel-faixa-cabecalho">
      <div><h2>{titulo}</h2><p className="muted">{descricao}</p>
        {avisoPrazo && <div className="work-tip">Prazo interno: 1 dia antes da Shopee
          <span className="work-tip-icon" tabIndex={0} aria-label="Como calculamos o prazo interno">ⓘ
            <span role="tooltip">Esta faixa usa “Postar até” da Shopee menos um dia. A agenda antecipa o prazo para a produção não depender do último dia permitido.</span>
          </span>
        </div>}
      </div>
      <div className="painel-faixa-resumo">
        <span>{formatDate(dias[0].data)} a {formatDate(dias[6].data)}</span>
        <b>{pedidos} pedidos</b><span>{BRL.format(total)} faturado</span>
        <span>{semLiquido === pedidos && pedidos > 0 ? '—' : BRL.format(liquido)} líquido{semLiquido > 0 ? '*' : ''}</span>
      </div>
    </div>
    <div className="painel-navegacao" aria-busy={loading}>
      <button type="button" className="painel-seta" aria-label={`Voltar um dia: ${titulo}`} disabled={loading || offset <= -3650} onClick={() => onNavigate(-1)}>‹</button>
      <div className="painel-dias">
      {dias.map((dia) => <article className={`painel-dia ${dia.data === hoje ? 'hoje' : ''}`} key={dia.data}>
        <h3>{DAY.format(new Date(`${dia.data}T12:00:00-03:00`))}{dia.data === hoje && <small>Hoje</small>}</h3>
        <div className="painel-dia-pedidos"><strong>{dia.pedidos}</strong> {dia.pedidos === 1 ? 'pedido' : 'pedidos'}</div>
        <dl>
          <div><dt>Faturado</dt><dd>{BRL.format(dia.total)}</dd></div>
          <div><dt>Líquido</dt><dd>{dia.semValorLiquido === dia.pedidos && dia.pedidos > 0 ? '—' : BRL.format(dia.liquido)}{dia.semValorLiquido > 0 && dia.semValorLiquido < dia.pedidos ? '*' : ''}</dd></div>
        </dl>
      </article>)}
      </div>
      <button type="button" className="painel-seta" aria-label={`Avançar um dia: ${titulo}`} disabled={loading || offset >= 3650} onClick={() => onNavigate(1)}>›</button>
    </div>
    {loading && <p className="painel-observacao">Atualizando período…</p>}
    {semLiquido > 0 && <p className="painel-observacao">* {semLiquido} {semLiquido === 1 ? 'pedido ainda não tem' : 'pedidos ainda não têm'} valor líquido calculado pela Shopee; o líquido exibido é parcial.</p>}
  </section>
}

export default function DashboardPage({ dataVersion = 0 }: Props): React.JSX.Element {
  const [painel, setPainel] = useState<Painel | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [diaAtual, setDiaAtual] = useState(0)
  const [offsets, setOffsets] = useState<PainelOffsets>(DEFAULT_PAINEL_OFFSETS)
  const [visibleOffsets, setVisibleOffsets] = useState<PainelOffsets>(DEFAULT_PAINEL_OFFSETS)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const proximaVirada = dashboardDates().bounds[2]
    const timer = setTimeout(() => setDiaAtual((day) => day + 1), Math.max(1000, proximaVirada - Date.now() + 1000))
    return () => clearTimeout(timer)
  }, [diaAtual])

  useEffect(() => {
    let ativo = true
    setErro(null)
    setLoading(true)
    void api.painel.resumo(offsets).then((result) => {
      if (ativo) { setPainel(result); setVisibleOffsets(offsets) }
    })
      .catch((error) => { if (ativo) setErro(String(error)) })
      .finally(() => { if (ativo) setLoading(false) })
    return () => { ativo = false }
  }, [dataVersion, diaAtual, offsets])

  if (!painel && !erro) return <div className="page"><div className="empty loading-indicator">Carregando painel…</div></div>
  if (!painel) return <div className="page"><div className="aviso">Não foi possível carregar o painel: {erro}</div></div>

  const hoje = dashboardDates().today
  const navigate = (group: keyof PainelOffsets, direction: number): void => {
    setOffsets({ ...visibleOffsets, [group]: visibleOffsets[group] + direction })
  }
  return <div className="page painel-page">
    <header className="page-header"><h1>Início</h1><span className="muted">7 dias por faixa</span></header>
    {erro && <div className="aviso">Não foi possível atualizar o período: {erro}</div>}
    <FaixaDias titulo="Vendas recentes" descricao="Pedidos feitos no período" dias={painel.vendasRecentes} hoje={hoje}
      offset={visibleOffsets.vendas} loading={loading} onNavigate={(direction) => navigate('vendas', direction)} />
    <FaixaDias titulo="Postar até" descricao="Pedidos a enviar pelo prazo interno de postagem" dias={painel.postagensPrevistas} hoje={hoje} avisoPrazo
      offset={visibleOffsets.previstas} loading={loading} onNavigate={(direction) => navigate('previstas', direction)} />
    {painel.semPrazoPostagem > 0 && <p className="painel-observacao">{painel.semPrazoPostagem} pedidos a enviar estão sem prazo de postagem informado pela Shopee.</p>}
    <FaixaDias titulo="Ganhos dos pedidos etiquetados" descricao="Pedidos cuja etiqueta foi gerada no período" dias={painel.etiquetasRecentes} hoje={hoje}
      offset={visibleOffsets.etiquetas} loading={loading} onNavigate={(direction) => navigate('etiquetas', direction)} />
    <p className="muted small">Faturado considera os produtos após cupons, sem o frete pago pelo comprador. Líquido é o valor calculado pela Shopee após cupons, frete e taxas, antes dos custos de produção.</p>
  </div>
}
