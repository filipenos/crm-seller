import { useEffect, useState } from 'react'
import type { LinhaFabricacao, ProductKind, Produto, ProdutoVariacao } from '@shared/types'

interface Props {
  dataVersion: number
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

function vendasPorCor(variacoes: ProdutoVariacao[]): { cor: string; kits: number; lacos: number }[] {
  const cores = new Map<string, { cor: string; kits: number; lacos: number }>()
  for (const variacao of variacoes) {
    if (variacao.kitsVendidos === 0) continue
    const cor = variacao.cor ?? variacao.nome ?? 'Cor não identificada'
    const atual = cores.get(cor) ?? { cor, kits: 0, lacos: 0 }
    atual.kits += variacao.kitsVendidos
    atual.lacos += variacao.quantidadePorKit === null
      ? variacao.lacosVendidos
      : variacao.kitsVendidos * variacao.quantidadePorKit
    cores.set(cor, atual)
  }
  return [...cores.values()].sort((a, b) => b.lacos - a.lacos || a.cor.localeCompare(b.cor, 'pt-BR'))
}

export default function ProdutosPage({ dataVersion }: Props): React.JSX.Element {
  const [produtos, setProdutos] = useState<Produto[]>([])
  const [linhas, setLinhas] = useState<LinhaFabricacao[]>([])
  const [sincronizando, setSincronizando] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandido, setExpandido] = useState<string | null>(null)
  const [salvando, setSalvando] = useState<string | null>(null)

  const carregar = async (): Promise<void> => {
    setLoading(true)
    try {
      const [novosProdutos, novasLinhas] = await Promise.all([
        window.api.produtos.list(),
        window.api.fabricacao.linhas()
      ])
      setProdutos(novosProdutos)
      setLinhas(novasLinhas)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void carregar()
  }, [dataVersion])

  const sincronizar = async (): Promise<void> => {
    setSincronizando(true)
    setAviso(null)
    const r = await window.api.produtos.sync()
    setSincronizando(false)
    // O endpoint de catálogo ainda não é confirmado por captura: quando falha, a
    // lista continua de pé porque ela vem dos pedidos.
    setAviso(
      r.ok
        ? `${r.produtos} produtos atualizados pela Shopee.`
        : `A Shopee não respondeu o catálogo (${r.error}). A lista abaixo continua valendo — ela vem dos pedidos.`
    )
    await carregar()
  }

  const mudarLinha = async (itemId: string, valor: string): Promise<void> => {
    setSalvando(itemId)
    try {
      await window.api.produtos.setLinha(itemId, valor === '' ? null : Number(valor))
      setProdutos((current) => current.map((p) => p.itemId === itemId ? { ...p, linhaId: valor === '' ? null : Number(valor) } : p))
    } catch (error) { setAviso(String(error)) }
    finally { setSalvando(null) }
  }

  const mudarTipo = async (itemId: string, tipo: ProductKind): Promise<void> => {
    setSalvando(itemId)
    try {
      await window.api.produtos.setTipo(itemId, tipo)
      const atualizados = await window.api.produtos.list()
      setProdutos(atualizados)
    } catch (error) { setAviso(String(error)) }
    finally { setSalvando(null) }
  }

  const totalCaixas = produtos.reduce((s, p) => s + p.caixasVendidas, 0)
  const totalLacos = produtos.reduce((s, p) => s + p.lacosVendidos, 0)

  return (
    <div className="page">
      <header className="page-header">
        <h1>Produtos</h1>
        <span className="muted">
          {produtos.length} produtos · {totalCaixas.toLocaleString('pt-BR')} caixas · {totalLacos.toLocaleString('pt-BR')} laços vendidos
        </span>
        <button className="primario" onClick={() => void sincronizar()} disabled={sincronizando}>
          {sincronizando ? 'Sincronizando…' : '↻ Sincronizar'}
        </button>
      </header>

      {aviso && <div className="aviso">{aviso}</div>}

      {loading && <div className="empty loading-indicator">Carregando produtos…</div>}

      {!loading && <table className="tabela">
        <thead>
          <tr>
            <th></th>
            <th>Produto</th>
            <th className="num">Pedidos</th>
            <th className="num">Unidades vendidas</th>
            <th className="num">Total</th>
            <th className="num">Líquido</th>
            <th className="num">Custo/caixa</th>
            <th>Composição atual</th>
          </tr>
        </thead>
          {produtos.map((p) => (<tbody key={p.itemId}>
            <tr>
              <td>
                {p.imagemUrl && <img className="miniatura" src={p.imagemUrl} alt="" loading="lazy" />}
              </td>
              <td>
                <div className="produto-nome">{p.nome}</div>
                <div className="produto-meta"><select aria-label={`Tipo de ${p.nome}`} value={p.tipo} disabled={salvando === p.itemId}
                  onChange={(e) => void mudarTipo(p.itemId, e.target.value as ProductKind)}>
                  <option value="CAIXAS">Kit de caixas</option>
                  <option value="LACOS">Kit de laços</option>
                  <option value="OUTRO">Outro produto</option>
                </select>
                <small className="muted">
                  {p.variacoes > 0 && `${p.variacoes} variações`}
                  {p.ultimoPedidoEm &&
                    `${p.variacoes > 0 ? ' · ' : ''}último em ${new Date(p.ultimoPedidoEm).toLocaleDateString('pt-BR')}`}
                  {p.ativo === false && ' · inativo na Shopee'}
                </small></div>
                {p.tipo === 'LACOS' && p.variacoesDetalhe.length > 0 &&
                  <button className="produto-variacoes-toggle" type="button" onClick={() => setExpandido(expandido === p.itemId ? null : p.itemId)}>
                    {expandido === p.itemId ? 'Ocultar vendas por cor' : 'Ver vendas por cor'}
                  </button>}
              </td>
              <td className="num">{p.pedidos}</td>
              <td className="num">{p.tipo === 'LACOS' ? `${p.lacosVendidos.toLocaleString('pt-BR')} laços` : p.tipo === 'CAIXAS' ? `${p.caixasVendidas.toLocaleString('pt-BR')} caixas` : '—'}</td>
              <td className="num">{BRL.format(p.vendas)}</td>
              <td className="num">
                {p.pedidos === p.pedidosSemLiquido + p.pedidosSemRateio ? '—' : BRL.format(p.liquido)}
                {p.pedidosSemLiquido + p.pedidosSemRateio > 0 &&
                  <div className="muted small">{p.pedidosSemLiquido + p.pedidosSemRateio} pedido(s) sem líquido atribuído</div>}
              </td>
              <td className="num">
                {/* Zero aqui não é "de graça", é "nenhuma compra registrada". */}
                {p.tipo !== 'CAIXAS' || !p.custoPorCaixa ? (
                  <span className="muted" title="Registre as compras dos insumos para ver o custo">
                    —
                  </span>
                ) : (
                  BRL.format(p.custoPorCaixa)
                )}
              </td>
              <td>
                {p.tipo === 'CAIXAS' && <select
                  value={p.linhaId ?? ''}
                  onChange={(e) => void mudarLinha(p.itemId, e.target.value)}
                >
                  <option value="">Padrão</option>
                  {linhas
                    .filter((l) => !l.padrao)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.nome}
                      </option>
                    ))}
                </select>}
              </td>
            </tr>
            {expandido === p.itemId && <tr><td colSpan={8}>
              <table className="tabela"><thead><tr><th>Cor</th><th className="num">Kits vendidos</th><th className="num">Laços vendidos</th></tr></thead><tbody>
                {vendasPorCor(p.variacoesDetalhe).map((v) => <tr key={v.cor}>
                  <td>{v.cor}</td>
                  <td className="num">{v.kits.toLocaleString('pt-BR')}</td>
                  <td className="num">{v.lacos.toLocaleString('pt-BR')}</td>
                </tr>)}
              </tbody></table>
            </td></tr>}
          </tbody>))}
      </table>}

      <p className="muted small">
        A lista reúne produtos e variações dos pedidos. Sincronizar atualiza preço, estoque e
        produtos que ainda não venderam. Kits de laços mostram as vendas agrupadas por cor;
        o custo por caixa se aplica apenas aos kits de caixas. O líquido considera as taxas da Shopee,
        antes do custo de produção. Pedidos com mais de um produto ficam sem valor atribuído até haver rateio.
      </p>
    </div>
  )
}
