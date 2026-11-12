import { useEffect, useState } from 'react'
import { api } from '@renderer/api'
import { dashboardDates } from '@shared/dashboardDays'
import { resolveReportPeriod, type SelecaoPeriodoRelatorio } from '@shared/managementReport'
import type { PeriodoRelatorio, RelatorioDia, RelatorioGerencial } from '@shared/types'

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const NUM = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const DATE = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' })

type Mode = SelecaoPeriodoRelatorio['tipo']

function dateLabel(day: string): string {
  return DATE.format(new Date(`${day}T12:00:00-03:00`))
}

function Kpi({ label, value, note }: { label: string; value: string; note?: string }): React.JSX.Element {
  return <div className="report-kpi"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>
}

function detailRows(days: RelatorioDia[], monthly: boolean): RelatorioDia[] {
  if (!monthly) return days
  const grouped = new Map<string, RelatorioDia>()
  for (const day of days) {
    const key = day.data.slice(0, 7)
    const row = grouped.get(key) ?? { data: `${key}-01`, pedidos: 0, cancelados: 0, faturado: 0, liquido: 0,
      despachados: 0, recebimentos: 0, recebido: 0, ads: null }
    row.pedidos += day.pedidos
    row.cancelados += day.cancelados
    row.faturado += day.faturado
    row.liquido += day.liquido
    row.despachados += day.despachados
    row.recebimentos += day.recebimentos
    row.recebido += day.recebido
    if (day.ads !== null) row.ads = (row.ads ?? 0) + day.ads
    grouped.set(key, row)
  }
  return [...grouped.values()]
}

export default function ManagementReportPage({ onOpenBuyer }: { onOpenBuyer: (username: string) => void }): React.JSX.Element {
  const today = dashboardDates().today
  const [mode, setMode] = useState<Mode>('esteMes')
  const [weekDay, setWeekDay] = useState(today)
  const [month, setMonth] = useState(today.slice(0, 7))
  const [year, setYear] = useState(Number(today.slice(0, 4)))
  const [customStart, setCustomStart] = useState(today)
  const [customEnd, setCustomEnd] = useState(today)
  const [period, setPeriod] = useState<PeriodoRelatorio>(() => resolveReportPeriod({ tipo: 'esteMes' }))
  const [data, setData] = useState<RelatorioGerencial | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void api.relatorio.gerencial(period)
      .then((result) => { if (active) setData(result) })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [period, revision])

  const apply = (): void => {
    try {
      const selection: SelecaoPeriodoRelatorio = mode === 'semana' ? { tipo: mode, data: weekDay }
        : mode === 'mes' ? { tipo: mode, mes: month }
          : mode === 'ano' ? { tipo: mode, ano: year }
            : mode === 'intervalo' ? { tipo: mode, inicio: customStart, fim: customEnd }
              : { tipo: mode }
      const next = resolveReportPeriod(selection)
      setError(null)
      setData(null)
      setPeriod(next)
      setRevision((value) => value + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const monthly = (Date.parse(period.fim) - Date.parse(period.inicio)) / 86_400_000 > 62
  const rows = detailRows(data?.dias ?? [], monthly)
  const adsAvailable = Boolean(data && data.ads.diasComDados > 0)
  return <div className="page report-page">
    <header className="page-header"><div><h1>Relatório gerencial</h1><p className="muted">Vendas, operação, recebimentos e Shopee Ads</p></div></header>
    <section className="report-filters">
      <label>Período<select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
        <option value="hoje">Hoje</option><option value="estaSemana">Esta semana</option>
        <option value="ultimos7">Últimos 7 dias</option><option value="esteMes">Este mês</option>
        <option value="ultimos30">Últimos 30 dias</option><option value="esteAno">Este ano</option>
        <option value="semana">Escolher semana</option><option value="mes">Escolher mês</option>
        <option value="ano">Escolher ano</option><option value="intervalo">Intervalo personalizado</option>
      </select></label>
      {mode === 'semana' && <label>Um dia da semana<input type="date" lang="pt-BR" value={weekDay} onChange={(event) => setWeekDay(event.target.value)} /></label>}
      {mode === 'mes' && <label>Mês<input type="month" lang="pt-BR" value={month} onChange={(event) => setMonth(event.target.value)} /></label>}
      {mode === 'ano' && <label>Ano<input type="number" min="2020" max="2100" value={year} onChange={(event) => setYear(Number(event.target.value))} /></label>}
      {mode === 'intervalo' && <><label>De<input type="date" lang="pt-BR" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label>
        <label>Até<input type="date" lang="pt-BR" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></>}
      <button className="primario" type="button" onClick={apply} disabled={loading}>Aplicar período</button>
    </section>
    {error && <div className="aviso alerta">Não foi possível carregar o relatório: {error}</div>}
    {loading && <div className="empty loading-indicator">Carregando relatório…</div>}
    {!loading && data && <>
      <p className="report-range">{dateLabel(data.periodo.inicio)} a {dateLabel(data.periodo.fim)}</p>
      <section className="report-section"><h2>Vendas feitas no período</h2>
        <div className="report-grid">
          <Kpi label="Pedidos" value={NUM.format(data.vendas.pedidos)} />
          <Kpi label="Cancelados" value={NUM.format(data.cancelamentos.pedidos)} note="Separados das vendas válidas" />
          <Kpi label="Faturado" value={BRL.format(data.vendas.faturado)} note={data.vendas.semExtrato ? `${data.vendas.semExtrato} pedido(s) sem extrato: valor estimado` : 'Produtos após cupons, sem frete'} />
          <Kpi label="Líquido dos pedidos" value={BRL.format(data.vendas.liquido)} note={data.vendas.semLiquido ? `${data.vendas.semLiquido} pedido(s) sem líquido` : 'Antes dos custos de produção'} />
          <Kpi label="Ticket médio" value={data.vendas.pedidos ? BRL.format(data.vendas.faturado / data.vendas.pedidos) : '—'} />
          <Kpi label="Caixas vendidas" value={NUM.format(data.vendas.caixas)} />
          <Kpi label="Laços vendidos" value={NUM.format(data.vendas.lacos)} note="Kits de laços; não inclui laços das caixas" />
        </div>
        <div className="report-breakdown"><span>Produtos antes dos cupons <b>{BRL.format(data.vendas.brutoProdutos)}</b></span>
          <span>Cupons <b>−{BRL.format(data.vendas.cupons)}</b></span><span>Taxas da Shopee <b>−{BRL.format(data.vendas.taxas)}</b></span>
          {data.vendas.faturado > 0 && <span>Taxas / faturado <b>{(100 * data.vendas.taxas / data.vendas.faturado).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</b></span>}</div>
        {data.cancelamentos.pedidos > 0 && <p className="muted small">Pedidos cancelados no período: {BRL.format(data.cancelamentos.valor)} em valor de produtos estimado. {data.cancelamentos.semExtrato > 0 && `${data.cancelamentos.semExtrato} sem extrato; nesses casos, o valor pode incluir frete.`}</p>}
      </section>
      <section className="report-section"><h2>Movimento no período</h2>
        <div className="report-grid">
          <Kpi label="Etiquetas geradas" value={NUM.format(data.movimento.etiquetas)} />
          <Kpi label="Despachados" value={NUM.format(data.movimento.despachados)} note="Postado ou coletado pela transportadora" />
          <Kpi label="Entregas confirmadas" value={NUM.format(data.movimento.entregues)} note="Rastreios com data de entrega" />
          <Kpi label="Recebimentos liberados" value={NUM.format(data.movimento.recebimentos)} />
          <Kpi label="Valor recebido" value={BRL.format(data.movimento.recebido)} note="Pela data da liberação" />
        </div>
        <p className="muted small">Despachos e entregas dependem dos rastreios já sincronizados; etiqueta gerada é uma etapa separada.</p>
        {(data.coberturaLogistica.semEtiqueta > 0 || data.coberturaLogistica.semPostagem > 0 || data.coberturaLogistica.semEntrega > 0) &&
          <p className="report-coverage">Histórico logístico incompleto nos pedidos vendidos neste período: {data.coberturaLogistica.semEtiqueta} sem data de etiqueta, {data.coberturaLogistica.semPostagem} sem registro de despacho e {data.coberturaLogistica.semEntrega} sem data de entrega. Os totais acima podem estar menores que o real; a sincronização completa pode recuperar datas disponíveis na Shopee.</p>}
      </section>
      <section className="report-section"><div className="report-section-head"><h2>Shopee Ads</h2><small>{data.ads.diasComDados} de {data.ads.diasNoPeriodo} dias com dados</small></div>
        <div className="report-grid">
          <Kpi label="Investimento" value={adsAvailable ? BRL.format(data.ads.investimento) : '—'} />
          <Kpi label="Vendas atribuídas" value={adsAvailable ? BRL.format(data.ads.vendasAtribuidas) : '—'} />
          <Kpi label="ROAS" value={data.ads.roas === null ? '—' : `${data.ads.roas.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}×`} />
          <Kpi label="Pedidos atribuídos" value={adsAvailable ? NUM.format(data.ads.pedidosAtribuidos) : '—'} />
          <Kpi label="Cliques" value={adsAvailable ? NUM.format(data.ads.cliques) : '—'} />
          <Kpi label="Líquido dos pedidos − Ads" value={data.ads.liquidoMenosAds === null ? '—' : BRL.format(data.ads.liquidoMenosAds)} note="Antes dos custos de produção" />
        </div>
        <p className="muted small">Ads inclui os dias sincronizados da Shopee. Vendas atribuídas já fazem parte do faturamento. “Líquido dos pedidos − Ads” compara pedidos e anúncios do mesmo período.</p>
      </section>
      <section className="report-section"><h2>Compradores recorrentes</h2>
        <p className="muted small">Compraram no período escolhido e têm pelo menos 2 pedidos válidos no histórico.</p>
        <div className="report-grid"><Kpi label="Compradores recorrentes" value={NUM.format(data.recorrentes.length)} /></div>
        {data.recorrentes.length > 0 && <div className="report-recurring-list">{data.recorrentes.map((buyer) =>
          <button type="button" key={buyer.usuario} onClick={() => onOpenBuyer(buyer.usuario)}>
            <span>{buyer.usuario}</span><small>{buyer.pedidosPeriodo} no período · {buyer.pedidosTotal} no histórico</small><span aria-hidden="true">→</span>
          </button>)}</div>}
      </section>
      <section className="report-section"><h2>Pendências atuais</h2><p className="muted small">Fotografia de agora; não muda ao escolher um período histórico.</p>
        <div className="report-grid">
          <Kpi label="A enviar" value={NUM.format(data.pendenciasAtuais.aEnviar)} />
          <Kpi label="A entregar" value={NUM.format(data.pendenciasAtuais.aEntregar)} />
          <Kpi label="A receber" value={NUM.format(data.pendenciasAtuais.aReceber)} />
          <Kpi label="Valor a receber" value={BRL.format(data.pendenciasAtuais.valorAReceber)} />
        </div>
      </section>
      <section className="report-section"><h2>{monthly ? 'Resumo por mês' : 'Resumo por dia'}</h2>
        <div className="report-table-wrap"><table className="tabela report-table"><thead><tr><th>{monthly ? 'Mês' : 'Dia'}</th><th className="num">Pedidos</th><th className="num">Cancelados</th><th className="num">Faturado</th><th className="num">Líquido</th><th className="num">Despachos</th><th className="num">Recebimentos</th><th className="num">Recebido</th><th className="num">Ads</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.data}><td>{monthly ? row.data.slice(5, 7) + '/' + row.data.slice(0, 4) : dateLabel(row.data)}</td>
            <td className="num">{NUM.format(row.pedidos)}</td><td className="num">{NUM.format(row.cancelados)}</td><td className="num">{BRL.format(row.faturado)}</td>
            <td className="num">{BRL.format(row.liquido)}</td><td className="num">{NUM.format(row.despachados)}</td>
            <td className="num">{NUM.format(row.recebimentos)}</td><td className="num">{BRL.format(row.recebido)}</td>
            <td className="num">{row.ads === null ? '—' : BRL.format(row.ads)}</td></tr>)}</tbody></table></div>
      </section>
    </>}
  </div>
}
