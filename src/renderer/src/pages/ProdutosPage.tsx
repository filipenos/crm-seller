import { useEffect, useState } from 'react'
import type { LinhaFabricacao, Produto } from '@shared/types'

interface Props {
  dataVersion: number
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export default function ProdutosPage({ dataVersion }: Props): React.JSX.Element {
  const [produtos, setProdutos] = useState<Produto[]>([])
  const [linhas, setLinhas] = useState<LinhaFabricacao[]>([])
  const [sincronizando, setSincronizando] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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
    await window.api.produtos.setLinha(itemId, valor === '' ? null : Number(valor))
    await carregar()
  }

  const totalCaixas = produtos.reduce((s, p) => s + p.caixasVendidas, 0)

  return (
    <div className="page">
      <header className="page-header">
        <h1>Produtos</h1>
        <span className="muted">
          {produtos.length} produtos · {totalCaixas.toLocaleString('pt-BR')} caixas vendidas
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
            <th className="num">Caixas</th>
            <th className="num">Vendas</th>
            <th className="num">Custo/caixa</th>
            <th>Composição atual</th>
          </tr>
        </thead>
        <tbody>
          {produtos.map((p) => (
            <tr key={p.itemId}>
              <td>
                {p.imagemUrl && <img className="miniatura" src={p.imagemUrl} alt="" loading="lazy" />}
              </td>
              <td>
                <div className="produto-nome">{p.nome}</div>
                <small className="muted">
                  {p.variacoes > 0 && `${p.variacoes} variações`}
                  {p.ultimoPedidoEm &&
                    `${p.variacoes > 0 ? ' · ' : ''}último em ${new Date(p.ultimoPedidoEm).toLocaleDateString('pt-BR')}`}
                  {p.ativo === false && ' · inativo na Shopee'}
                </small>
              </td>
              <td className="num">{p.pedidos}</td>
              <td className="num">{p.caixasVendidas.toLocaleString('pt-BR')}</td>
              <td className="num">{BRL.format(p.vendas)}</td>
              <td className="num">
                {/* Zero aqui não é "de graça", é "nenhuma compra registrada". */}
                {!p.custoPorCaixa ? (
                  <span className="muted" title="Registre as compras dos insumos para ver o custo">
                    —
                  </span>
                ) : (
                  BRL.format(p.custoPorCaixa)
                )}
              </td>
              <td>
                <select
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
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>}

      <p className="muted small">
        A lista sai dos próprios pedidos — cada item vendido carrega o produto e a variação, então
        ela existe sem sincronizar nada. Sincronizar acrescenta o que os pedidos não sabem: preço de
        hoje, estoque anunciado e produtos que ainda não venderam. O custo por caixa é a média dos
        modelos da composição atual, e só conta o que tem quantidade e compra registradas.
      </p>
    </div>
  )
}
