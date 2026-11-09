import { useEffect, useState } from 'react'
import type { DiaPainel, Painel } from '@shared/types'
import { dashboardDates } from '@shared/dashboardDays'
import { api } from '@renderer/api'

interface Props { dataVersion?: number }

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const DAY = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })

function FaixaDias({ titulo, descricao, dias, hoje }: {
  titulo: string; descricao: string; dias: DiaPainel[]; hoje: string
}): React.JSX.Element {
  const pedidos = dias.reduce((sum, dia) => sum + dia.pedidos, 0)
  const total = dias.reduce((sum, dia) => sum + dia.total, 0)
  const liquido = dias.reduce((sum, dia) => sum + dia.liquido, 0)
  const semLiquido = dias.reduce((sum, dia) => sum + dia.semValorLiquido, 0)
  return <section className="painel-faixa">
    <div className="painel-faixa-cabecalho">
      <div><h2>{titulo}</h2><p className="muted">{descricao}</p></div>
      <div className="painel-faixa-resumo">
        <b>{pedidos} pedidos</b><span>{BRL.format(total)} total</span>
        <span>{semLiquido === pedidos && pedidos > 0 ? '—' : BRL.format(liquido)} líquido{semLiquido > 0 ? '*' : ''}</span>
      </div>
    </div>
    <div className="painel-dias">
      {dias.map((dia) => <article className={`painel-dia ${dia.data === hoje ? 'hoje' : ''}`} key={dia.data}>
        <h3>{DAY.format(new Date(`${dia.data}T12:00:00-03:00`))}{dia.data === hoje && <small>Hoje</small>}</h3>
        <div className="painel-dia-pedidos"><strong>{dia.pedidos}</strong> {dia.pedidos === 1 ? 'pedido' : 'pedidos'}</div>
        <dl>
          <div><dt>Total</dt><dd>{BRL.format(dia.total)}</dd></div>
          <div><dt>Líquido</dt><dd>{dia.semValorLiquido === dia.pedidos && dia.pedidos > 0 ? '—' : BRL.format(dia.liquido)}{dia.semValorLiquido > 0 && dia.semValorLiquido < dia.pedidos ? '*' : ''}</dd></div>
        </dl>
      </article>)}
    </div>
    {semLiquido > 0 && <p className="painel-observacao">* {semLiquido} {semLiquido === 1 ? 'pedido ainda não tem' : 'pedidos ainda não têm'} valor líquido calculado pela Shopee; o líquido exibido é parcial.</p>}
  </section>
}

export default function DashboardPage({ dataVersion = 0 }: Props): React.JSX.Element {
  const [painel, setPainel] = useState<Painel | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [diaAtual, setDiaAtual] = useState(0)

  useEffect(() => {
    const proximaVirada = dashboardDates().bounds[2]
    const timer = setTimeout(() => setDiaAtual((day) => day + 1), Math.max(1000, proximaVirada - Date.now() + 1000))
    return () => clearTimeout(timer)
  }, [diaAtual])

  useEffect(() => {
    let ativo = true
    setErro(null)
    void api.painel.resumo().then((result) => { if (ativo) setPainel(result) })
      .catch((error) => { if (ativo) setErro(String(error)) })
    return () => { ativo = false }
  }, [dataVersion, diaAtual])

  if (erro) return <div className="page"><div className="aviso">Não foi possível carregar o painel: {erro}</div></div>
  if (!painel) return <div className="page"><div className="empty loading-indicator">Carregando painel…</div></div>

  const hoje = painel.vendasRecentes[6]?.data ?? ''
  return <div className="page painel-page">
    <header className="page-header"><h1>Início</h1><span className="muted">7 dias por faixa, incluindo hoje</span></header>
    <FaixaDias titulo="Vendas recentes" descricao="Pedidos feitos nos últimos 7 dias" dias={painel.vendasRecentes} hoje={hoje} />
    <FaixaDias titulo="Postar até" descricao="Pedidos a enviar pelo prazo de postagem dos próximos 7 dias" dias={painel.postagensPrevistas} hoje={hoje} />
    {painel.semPrazoPostagem > 0 && <p className="painel-observacao">{painel.semPrazoPostagem} pedidos a enviar estão sem prazo de postagem informado pela Shopee.</p>}
    <FaixaDias titulo="Ganhos dos pedidos etiquetados" descricao="Pedidos cuja etiqueta foi gerada nos últimos 7 dias" dias={painel.etiquetasRecentes} hoje={hoje} />
    <p className="muted small">Líquido é o valor calculado pela Shopee após cupons, frete e taxas, antes dos custos de produção.</p>
  </div>
}
