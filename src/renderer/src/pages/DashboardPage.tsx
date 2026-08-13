import { useEffect, useState } from 'react'
import type { MetricaPainel, Painel, ResumoPeriodo } from '@shared/types'
import DetalheMetrica from '../components/DetalheMetrica'

interface Props {
  dataVersion: number
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

/** Uma métrica, com o valor de hoje grande e os períodos maiores como contexto. */
function Kpi({
  rotulo,
  hoje,
  sete,
  trinta,
  dica,
  onClick
}: {
  rotulo: string
  hoje: string
  sete: string
  trinta: string
  dica?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <div className="kpi clicavel" title={dica} onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}>
      <div className="kpi-rotulo">{rotulo}</div>
      <div className="kpi-valor">{hoje}</div>
      <div className="kpi-periodos">
        <span>
          7d <b>{sete}</b>
        </span>
        <span>
          30d <b>{trinta}</b>
        </span>
      </div>
    </div>
  )
}

/** Cartão de estado atual — não é período, é o que está pendente agora. */
function Agora({
  rotulo,
  valor,
  destaque
}: {
  rotulo: string
  valor: string
  destaque?: boolean
}): React.JSX.Element {
  return (
    <div className={`agora ${destaque ? 'alerta' : ''}`}>
      <div className="agora-valor">{valor}</div>
      <div className="agora-rotulo">{rotulo}</div>
    </div>
  )
}

export default function DashboardPage({ dataVersion }: Props): React.JSX.Element {
  const [p, setP] = useState<Painel | null>(null)
  const [detalhe, setDetalhe] = useState<MetricaPainel | null>(null)

  useEffect(() => {
    void window.api.painel.resumo().then(setP)
  }, [dataVersion])

  if (!p) return <div className="page" />

  const n = (f: (r: ResumoPeriodo) => number): [string, string, string] => [
    String(f(p.hoje)),
    String(f(p.ultimos7)),
    String(f(p.ultimos30))
  ]
  const money = (f: (r: ResumoPeriodo) => number): [string, string, string] => [
    BRL.format(f(p.hoje)),
    BRL.format(f(p.ultimos7)),
    BRL.format(f(p.ultimos30))
  ]

  const [pedHoje, ped7, ped30] = n((r) => r.pedidos)
  const [cxHoje, cx7, cx30] = n((r) => r.caixas)
  const [venHoje, ven7, ven30] = money((r) => r.vendas)
  const [recHoje, rec7, rec30] = money((r) => r.recebido)
  const [desHoje, des7, des30] = n((r) => r.despachados)

  return (
    <div className="page">
      <header className="page-header">
        <h1>Início</h1>
        <span className="muted">hoje · comparado com 7 e 30 dias</span>
      </header>

      <div className="kpis">
        <Kpi onClick={() => setDetalhe('pedidos')} rotulo="Pedidos" hoje={pedHoje} sete={ped7} trinta={ped30} dica="Pedidos que entraram, sem contar cancelados" />
        <Kpi onClick={() => setDetalhe('caixas')} rotulo="Caixas vendidas" hoje={cxHoje} sete={cx7} trinta={cx30} dica="Somadas pela variação do kit: 20 peças, 30 peças…" />
        <Kpi onClick={() => setDetalhe('vendas')} rotulo="Vendas" hoje={venHoje} sete={ven7} trinta={ven30} dica="O que os clientes pagaram nos pedidos do período" />
        <Kpi onClick={() => setDetalhe('recebido')} rotulo="Recebido" hoje={recHoje} sete={rec7} trinta={rec30} dica="Dinheiro liberado pela Shopee no período, já com as taxas descontadas" />
        <Kpi onClick={() => setDetalhe('despachados')} rotulo="Despachados" hoje={desHoje} sete={des7} trinta={des30} dica="Pedidos deixados no ponto de coleta" />
      </div>

      <h3 className="secao-agora">Agora</h3>
      <div className="agoras">
        <Agora rotulo="A enviar" valor={String(p.aEnviar)} />
        <Agora rotulo="Prontos para postar" valor={String(p.prontosParaPostar)} />
        <Agora
          rotulo="Postar em 24h"
          valor={String(p.prazoApertado)}
          destaque={p.prazoApertado > 0}
        />
        <Agora rotulo="Em trânsito" valor={String(p.emTransito)} />
        <Agora
          rotulo={`A receber (${p.pedidosAReceber} pedidos)`}
          valor={BRL.format(p.aReceber)}
        />
      </div>

      {detalhe && <DetalheMetrica metrica={detalhe} onClose={() => setDetalhe(null)} />}

      <p className="muted small">
        A data do pedido vem do próprio número (AAMMDD) — o card da Shopee não traz hora, então
        os períodos são por dia. Recebimento e despacho têm hora real, do extrato e do rastreio.
      </p>
    </div>
  )
}
