import { useEffect, useState } from 'react'
import type { PeriodoDesempenho, ResumoDesempenho } from '@shared/types'
import { api } from '@renderer/api'

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const NUM = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const PCT = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 2 })

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }): React.JSX.Element {
  return <div className="performance-kpi"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>
}

export default function PerformancePage({ readOnly = false }: { readOnly?: boolean }): React.JSX.Element {
  const today = new Date()
  const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 29)
  const dateValue = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const [data, setData] = useState<ResumoDesempenho | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'geral' | 'produtos' | 'ofertas'>('geral')
  const [productQuery, setProductQuery] = useState('')
  const [period, setPeriod] = useState<PeriodoDesempenho>({ inicio: dateValue(monthAgo), fim: dateValue(today) })

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const summary = await api.desempenho.resumo(period)
      setData(summary)
    }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  const sync = async (): Promise<void> => {
    setSyncing(true)
    setError(null)
    try {
      await api.desempenho.sincronizar(period)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setSyncing(false) }
  }

  const visibleProducts = data?.produtos.filter((product) =>
    product.nome.toLocaleLowerCase('pt-BR').includes(productQuery.trim().toLocaleLowerCase('pt-BR'))
  ) ?? []

  return <div className="page performance-page">
    <header className="page-header">
      <div><h1>Desempenho</h1><span className="muted">Produtos, Shopee Ads e Oferta Relâmpago</span></div>
      <div className="performance-actions">
        <label>De<input type="date" lang="pt-BR" value={period.inicio} max={period.fim} onChange={(event) => setPeriod((current) => ({ ...current, inicio: event.target.value }))} /></label>
        <label>Até<input type="date" lang="pt-BR" value={period.fim} min={period.inicio} onChange={(event) => setPeriod((current) => ({ ...current, fim: event.target.value }))} /></label>
        <button onClick={() => void load()} disabled={loading || syncing}>Aplicar período</button>
        {!readOnly && <button className="primario performance-sync" onClick={() => void sync()} disabled={syncing}>
          {syncing ? 'Sincronizando…' : '↻ Sincronizar período'}
        </button>}
      </div>
    </header>
    {error && <div className="aviso erro">{error.replace(/^Error invoking remote method '[^']+': Error:\s*/, '')}</div>}
    {loading && <div className="empty loading-indicator">Carregando desempenho…</div>}
    {!loading && !data && <div className="performance-empty"><strong>Ainda não há dados de desempenho.</strong><span>Escolha o período e clique em “Sincronizar período” para buscar as métricas na Shopee.</span></div>}
    {!loading && data && <>
      <div className="performance-period">De {new Date(data.inicio).toLocaleDateString('pt-BR')} a {new Date(data.fim).toLocaleDateString('pt-BR')} · atualizado em {new Date(data.sincronizadoEm).toLocaleString('pt-BR')}</div>
      <div className="subtabs">
        <button className={tab === 'geral' ? 'active' : ''} onClick={() => setTab('geral')}>Visão geral</button>
        <button className={tab === 'produtos' ? 'active' : ''} onClick={() => setTab('produtos')}>Produtos</button>
        <button className={tab === 'ofertas' ? 'active' : ''} onClick={() => setTab('ofertas')}>Oferta Relâmpago</button>
      </div>
      {tab === 'geral' && <>
        <h2 className="section-title">Loja</h2>
        <div className="performance-grid">
          <Kpi label="Impressões" value={NUM.format(data.geral.impressoes)} />
          <Kpi label="Cliques" value={NUM.format(data.geral.cliques)} detail={`CTR ${PCT.format(data.geral.impressoes ? data.geral.cliques / data.geral.impressoes : 0)}`} />
          <Kpi label="Pedidos" value={NUM.format(data.geral.pedidos)} />
          <Kpi label="Vendas" value={BRL.format(data.geral.vendas)} />
        </div>
        <h2 className="section-title">Shopee Ads</h2>
        <div className="performance-grid ads">
          <Kpi label="Investimento" value={BRL.format(data.ads.investimento)} />
          <Kpi label="Vendas atribuídas" value={BRL.format(data.ads.vendas)} />
          <Kpi label="ROAS" value={data.ads.roas === null ? '—' : data.ads.roas.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} detail="vendas ÷ investimento" />
          <Kpi label="Pedidos atribuídos" value={NUM.format(data.ads.pedidos)} />
          <Kpi label="Cliques" value={NUM.format(data.ads.cliques)} />
          <Kpi label="CPC" value={data.ads.cpc === null ? '—' : BRL.format(data.ads.cpc)} />
        </div>
        <p className="muted small">O período é calculado com o histórico diário salvo no Turso. O ROAS mede retorno em vendas, não lucro. A margem real poderá descontar taxas e o custo da composição quando os produtos estiverem vinculados.</p>
      </>}
      {tab === 'produtos' && <>
        <div className="performance-product-filter">
          <input type="search" value={productQuery} onChange={(event) => setProductQuery(event.target.value)} placeholder="Buscar produto pelo nome…" aria-label="Buscar produto pelo nome" />
          <span className="muted">{visibleProducts.length} de {data.produtos.length} produtos</span>
        </div>
        <table className="tabela performance-table"><thead><tr><th>Produto</th><th className="num">Impressões</th><th className="num">Cliques</th><th className="num">CTR</th><th className="num">Carrinho</th><th className="num">Pedidos</th><th className="num">Conversão</th><th className="num">Vendas</th></tr></thead><tbody>
          {visibleProducts.map((p) => <tr key={p.itemId}><td><div className="performance-product">{p.imagemUrl && <img className="miniatura" src={p.imagemUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none' }} />}<span>{p.nome}</span></div></td><td className="num">{NUM.format(p.impressoes)}</td><td className="num">{NUM.format(p.cliques)}</td><td className="num">{PCT.format(p.ctr)}</td><td className="num">{NUM.format(p.adicionaramAoCarrinho)}</td><td className="num">{NUM.format(p.pedidos)}</td><td className="num">{PCT.format(p.conversao)}</td><td className="num">{BRL.format(p.vendas)}</td></tr>)}
          {visibleProducts.length === 0 && <tr><td colSpan={8} className="empty">Nenhum produto encontrado.</td></tr>}
        </tbody></table>
      </>}
      {tab === 'ofertas' && <><div className="performance-grid"><Kpi label="Ofertas encontradas" value={NUM.format(data.ofertaRelampago.campanhas)} /><Kpi label="Visualizadores" value={NUM.format(data.ofertaRelampago.espectadores)} /><Kpi label="Impressões" value={NUM.format(data.ofertaRelampago.impressoes)} /><Kpi label="Cliques" value={NUM.format(data.ofertaRelampago.cliques)} /><Kpi label="Pedidos" value={NUM.format(data.ofertaRelampago.pedidos)} /><Kpi label="Vendas" value={BRL.format(data.ofertaRelampago.vendas)} /></div><p className="muted small">Métricas informadas pela ferramenta Oferta Relâmpago da Shopee no período disponível.</p></>}
    </>}
  </div>
}
