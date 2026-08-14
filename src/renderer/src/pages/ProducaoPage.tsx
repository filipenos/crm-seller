import { useEffect, useState } from 'react'
import type { Compra, Insumo, LinhaFabricacao, Receita } from '@shared/types'
import { TIPO_RECEITA_LABELS, UNIDADES } from '@shared/types'

interface Props {
  dataVersion: number
}

type Aba = 'insumos' | 'compras' | 'fabricacao'

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * Preço de insumo é centavo de centavo, e arredondar mente.
 *
 * O cm da fita nº9 custa 0,0114: mostrado com duas casas viraria "R$ 0,01" e
 * esconderia 14% do valor. Abaixo de um real, então, vão até quatro casas — sem
 * zeros à toa, para 0,32 não virar "0,3200".
 */
function dinheiro(v: number | null): string {
  if (v === null) return '—'
  if (v === 0 || Math.abs(v) >= 1) return BRL.format(v)
  const texto = v.toFixed(4).replace(/(\d\d)(0+)$/, '$1')
  return `R$ ${texto.replace('.', ',')}`
}

function hoje(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function ProducaoPage({ dataVersion }: Props): React.JSX.Element {
  const [aba, setAba] = useState<Aba>('insumos')
  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [compras, setCompras] = useState<Compra[]>([])
  const [linhas, setLinhas] = useState<LinhaFabricacao[]>([])
  const [componentes, setComponentes] = useState<Receita[]>([])
  const [desde, setDesde] = useState<number | null>(null)

  const carregar = async (): Promise<void> => {
    setInsumos(await window.api.insumos.list())
    setCompras(await window.api.compras.list())
    setLinhas(await window.api.fabricacao.linhas())
    setComponentes(await window.api.fabricacao.componentes())
    setDesde(await window.api.estoque.desde())
  }

  useEffect(() => {
    void carregar()
  }, [dataVersion])

  const acabando = insumos.filter((i) => i.acabando)

  return (
    <div className="page">
      <header className="page-header">
        <h1>Produção</h1>
        <span className="muted">o que é preciso para fazer, e o que ainda tem</span>
      </header>

      {acabando.length > 0 && (
        <div className="aviso alerta">
          Está acabando:{' '}
          {acabando.map((i) => `${i.nome} (${i.estoque} ${i.unidade})`).join(' · ')}
        </div>
      )}

      <div className="abas">
        <button className={aba === 'insumos' ? 'ativa' : ''} onClick={() => setAba('insumos')}>
          Insumos
        </button>
        <button className={aba === 'compras' ? 'ativa' : ''} onClick={() => setAba('compras')}>
          Compras
        </button>
        <button className={aba === 'fabricacao' ? 'ativa' : ''} onClick={() => setAba('fabricacao')}>
          Fabricação
        </button>
      </div>

      {aba === 'insumos' && <AbaInsumos insumos={insumos} desde={desde} recarregar={carregar} />}
      {aba === 'compras' && (
        <AbaCompras insumos={insumos} compras={compras} recarregar={carregar} />
      )}
      {aba === 'fabricacao' && (
        <AbaFabricacao
          linhas={linhas}
          componentes={componentes}
          insumos={insumos}
          recarregar={carregar}
        />
      )}
    </div>
  )
}

// ---------- insumos ----------

function AbaInsumos({
  insumos,
  desde,
  recarregar
}: {
  insumos: Insumo[]
  desde: number | null
  recarregar: () => Promise<void>
}): React.JSX.Element {
  const [novo, setNovo] = useState({ nome: '', unidade: 'un', estoqueMinimo: '' })

  const criar = async (): Promise<void> => {
    if (!novo.nome.trim()) return
    await window.api.insumos.criar({
      nome: novo.nome.trim(),
      unidade: novo.unidade,
      estoqueMinimo: novo.estoqueMinimo === '' ? null : Number(novo.estoqueMinimo)
    })
    setNovo({ nome: '', unidade: 'un', estoqueMinimo: '' })
    await recarregar()
  }

  const ajustar = async (varianteId: number, unidade: string): Promise<void> => {
    const txt = window.prompt(
      `Quanto entrou ou saiu, em ${unidade}? Use número negativo para saída (ex.: -30).`
    )
    if (!txt) return
    const n = Number(txt.replace(',', '.'))
    if (!Number.isFinite(n) || n === 0) return
    await window.api.estoque.ajustar(varianteId, n, 'ajuste manual')
    await recarregar()
  }

  const novaVariante = async (insumoId: number): Promise<void> => {
    const nome = window.prompt('Nome da cor ou versão (ex.: Azul):')
    if (!nome?.trim()) return
    await window.api.insumos.criarVariante(insumoId, nome.trim())
    await recarregar()
  }

  const mudarMinimo = async (insumo: Insumo): Promise<void> => {
    const txt = window.prompt(
      `Avisar quando ${insumo.nome} ficar abaixo de quantos ${insumo.unidade}? (vazio desliga o aviso)`,
      insumo.estoqueMinimo === null ? '' : String(insumo.estoqueMinimo)
    )
    if (txt === null) return
    await window.api.insumos.atualizar(insumo.id, {
      estoqueMinimo: txt.trim() === '' ? null : Number(txt.replace(',', '.'))
    })
    await recarregar()
  }

  return (
    <>
      <table className="tabela">
        <thead>
          <tr>
            <th>Insumo</th>
            <th className="num">Estoque</th>
            <th className="num">Custo médio</th>
            <th>Cores / versões</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {insumos.map((i) => (
            <tr key={i.id} className={i.acabando ? 'linha-alerta' : ''}>
              <td>
                <b>{i.nome}</b>
                <small className="muted"> · {i.unidade}</small>
                {i.estoqueMinimo !== null && (
                  <small className="muted"> · avisa abaixo de {i.estoqueMinimo}</small>
                )}
              </td>
              <td className="num">
                {i.estoque.toLocaleString('pt-BR')} {i.unidade}
              </td>
              <td className="num">
                {i.custoMedio === null ? (
                  <span className="muted">sem compra</span>
                ) : (
                  <>
                    {dinheiro(i.custoMedio)}
                    <small className="muted">/{i.unidade}</small>
                  </>
                )}
              </td>
              <td>
                <div className="chips">
                  {i.variantes.map((v) => (
                    <button
                      key={v.id}
                      className="chip"
                      title="Ajustar o estoque desta cor"
                      onClick={() => void ajustar(v.id, i.unidade)}
                    >
                      {v.nome}: {v.estoque.toLocaleString('pt-BR')}
                    </button>
                  ))}
                  <button className="chip adicionar" onClick={() => void novaVariante(i.id)}>
                    + cor
                  </button>
                </div>
              </td>
              <td className="acoes">
                <button onClick={() => void mudarMinimo(i)}>Aviso</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="form-linha">
        <input
          placeholder="Novo insumo"
          value={novo.nome}
          onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
        />
        <select value={novo.unidade} onChange={(e) => setNovo({ ...novo, unidade: e.target.value })}>
          {UNIDADES.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <input
          className="medio"
          placeholder="Avisar abaixo de"
          value={novo.estoqueMinimo}
          onChange={(e) => setNovo({ ...novo, estoqueMinimo: e.target.value })}
        />
        <button className="primario" onClick={() => void criar()}>
          Adicionar
        </button>
      </div>

      <p className="muted small">
        O estoque é o saldo dos movimentos: compra soma, pedido despachado subtrai, ajuste corrige.
        As saídas contam a partir de{' '}
        {desde ? new Date(desde).toLocaleDateString('pt-BR') : 'agora'} — o que foi despachado antes
        disso é história, e descontar aquilo faria o estoque nascer centenas de unidades negativo.
        Quando a receita não diz a cor, a baixa tira da que tem mais.
      </p>
    </>
  )
}

// ---------- compras ----------

function AbaCompras({
  insumos,
  compras,
  recarregar
}: {
  insumos: Insumo[]
  compras: Compra[]
  recarregar: () => Promise<void>
}): React.JSX.Element {
  const [form, setForm] = useState({
    varianteId: '',
    quantidade: '',
    valor: '',
    frete: '',
    data: hoje(),
    fornecedor: ''
  })

  const registrar = async (): Promise<void> => {
    const varianteId = Number(form.varianteId)
    const quantidade = Number(form.quantidade.replace(',', '.'))
    const valor = Number(form.valor.replace(',', '.'))
    if (!varianteId || !quantidade || !Number.isFinite(valor)) return
    await window.api.compras.registrar({
      varianteId,
      quantidade,
      valor,
      frete: form.frete === '' ? 0 : Number(form.frete.replace(',', '.')),
      // A data escolhida vale como meio-dia local, para não escorregar de dia.
      compradoEm: new Date(`${form.data}T12:00:00`).getTime(),
      fornecedor: form.fornecedor.trim() || null
    })
    setForm({ ...form, quantidade: '', valor: '', frete: '', fornecedor: '' })
    await recarregar()
  }

  const remover = async (id: number): Promise<void> => {
    await window.api.compras.remover(id)
    await recarregar()
  }

  const previa = (): string | null => {
    const q = Number(form.quantidade.replace(',', '.'))
    const v = Number(form.valor.replace(',', '.'))
    const f = form.frete === '' ? 0 : Number(form.frete.replace(',', '.'))
    if (!q || !Number.isFinite(v)) return null
    return `sai a ${dinheiro((v + f) / q)} cada`
  }

  return (
    <>
      <div className="form-compra">
        <select
          value={form.varianteId}
          onChange={(e) => setForm({ ...form, varianteId: e.target.value })}
        >
          <option value="">O que comprou…</option>
          {insumos.map((i) => (
            <optgroup key={i.id} label={`${i.nome} (${i.unidade})`}>
              {i.variantes.map((v) => (
                <option key={v.id} value={v.id}>
                  {i.nome} — {v.nome}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <input
          className="curto"
          placeholder="Quantidade"
          value={form.quantidade}
          onChange={(e) => setForm({ ...form, quantidade: e.target.value })}
        />
        <input
          className="curto"
          placeholder="Valor pago"
          value={form.valor}
          onChange={(e) => setForm({ ...form, valor: e.target.value })}
        />
        <input
          className="curto"
          placeholder="Frete"
          value={form.frete}
          onChange={(e) => setForm({ ...form, frete: e.target.value })}
        />
        <input
          type="date"
          value={form.data}
          onChange={(e) => setForm({ ...form, data: e.target.value })}
        />
        <input
          placeholder="Fornecedor"
          value={form.fornecedor}
          onChange={(e) => setForm({ ...form, fornecedor: e.target.value })}
        />
        <button className="primario" onClick={() => void registrar()}>
          Registrar
        </button>
        {previa() && <span className="muted">{previa()}</span>}
      </div>

      <table className="tabela">
        <thead>
          <tr>
            <th>Data</th>
            <th>Insumo</th>
            <th className="num">Quantidade</th>
            <th className="num">Valor</th>
            <th className="num">Frete</th>
            <th className="num">Custo unitário</th>
            <th>Fornecedor</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {compras.map((c) => (
            <tr key={c.id}>
              <td>{new Date(c.compradoEm).toLocaleDateString('pt-BR')}</td>
              <td>
                {c.insumoNome} <small className="muted">{c.varianteNome}</small>
              </td>
              <td className="num">
                {c.quantidade.toLocaleString('pt-BR')} {c.unidade}
              </td>
              <td className="num">{BRL.format(c.valor)}</td>
              <td className="num">{c.frete ? BRL.format(c.frete) : '—'}</td>
              <td className="num">{dinheiro(c.custoUnitario)}</td>
              <td>{c.fornecedor ?? <span className="muted">—</span>}</td>
              <td className="acoes">
                <button onClick={() => void remover(c.id)}>✕</button>
              </td>
            </tr>
          ))}
          {compras.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                Nenhuma compra registrada ainda. Sem elas o app sabe o que é preciso para fabricar,
                mas não quanto custa.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="muted small">
        O frete entra no custo: 1000 folhas por {BRL.format(300)} com {BRL.format(20)} de frete saem
        a {dinheiro(0.32)} cada. O custo médio de um insumo é tudo o que foi pago dividido por tudo
        o que foi comprado — não a média dos preços, que ignoraria o tamanho de cada compra.
      </p>
    </>
  )
}

// ---------- fabricação ----------

function AbaFabricacao({
  linhas,
  componentes,
  insumos,
  recarregar
}: {
  linhas: LinhaFabricacao[]
  componentes: Receita[]
  insumos: Insumo[]
  recarregar: () => Promise<void>
}): React.JSX.Element {
  const criarLinha = async (): Promise<void> => {
    const nome = window.prompt('Nome da nova linha de fabricação (ex.: Fabricação com fita dupla):')
    if (!nome?.trim()) return
    await window.api.fabricacao.criarLinha(nome.trim())
    await recarregar()
  }

  return (
    <>
      {componentes.length > 0 && (
        <section className="bloco">
          <h3>Componentes</h3>
          <p className="muted small">
            Servem a qualquer linha. O laço é um: cadastrado uma vez, ele entra na milk e na
            pirâmide, e encarecer a fita encarece as duas de uma vez.
          </p>
          {componentes.map((r) => (
            <CartaoReceita
              key={r.id}
              receita={r}
              insumos={insumos}
              componentes={componentes}
              recarregar={recarregar}
            />
          ))}
        </section>
      )}

      {linhas.map((linha) => (
        <section key={linha.id} className="bloco">
          <h3>
            {linha.nome}
            {linha.padrao && <span className="tag">padrão</span>}
            <small className="muted">
              {' '}
              {linha.produtos} produtos · caixa média {dinheiro(linha.custoPorCaixa)}
            </small>
          </h3>
          {linha.receitas.map((r) => (
            <CartaoReceita
              key={r.id}
              receita={r}
              insumos={insumos}
              componentes={componentes}
              recarregar={recarregar}
            />
          ))}
          <NovaReceita linhaId={linha.id} recarregar={recarregar} />
        </section>
      ))}

      <button onClick={() => void criarLinha()}>+ Nova linha de fabricação</button>

      <p className="muted small">
        Um kit se reparte igualmente entre os modelos da linha — a própria variação da Shopee diz
        isso ("20 peças / 4 de cada modelo"), então o tamanho do kit não precisa ser cadastrado. A
        embalagem entra uma vez por pedido. Item sem quantidade, como a cola, aparece na lista do
        que é preciso ter mas fica fora do custo: por isso o total é sempre um piso.
      </p>
    </>
  )
}

function CartaoReceita({
  receita,
  insumos,
  componentes,
  recarregar
}: {
  receita: Receita
  insumos: Insumo[]
  componentes: Receita[]
  recarregar: () => Promise<void>
}): React.JSX.Element {
  const [alvo, setAlvo] = useState('')
  const [qtd, setQtd] = useState('')

  const adicionar = async (): Promise<void> => {
    if (!alvo) return
    const quantidade = qtd.trim() === '' ? null : Number(qtd.replace(',', '.'))
    const [tipo, id] = alvo.split(':')
    await window.api.fabricacao.adicionarItem({
      receitaId: receita.id,
      insumoId: tipo === 'insumo' ? Number(id) : null,
      receitaFilhaId: tipo === 'receita' ? Number(id) : null,
      quantidade
    })
    setAlvo('')
    setQtd('')
    await recarregar()
  }

  const remover = async (id: number): Promise<void> => {
    await window.api.fabricacao.removerItem(id)
    await recarregar()
  }

  const removerReceita = async (): Promise<void> => {
    if (!window.confirm(`Apagar a receita "${receita.nome}"?`)) return
    await window.api.fabricacao.removerReceita(receita.id)
    await recarregar()
  }

  return (
    <div className="receita">
      <div className="receita-topo">
        <b>{receita.nome}</b>
        <span className="tag suave">{TIPO_RECEITA_LABELS[receita.tipo]}</span>
        <span className="receita-custo">{dinheiro(receita.custo)}</span>
        {receita.incertos > 0 && (
          <span className="muted small" title="Itens sem quantidade certa ou sem compra registrada">
            +{receita.incertos} sem preço
          </span>
        )}
        <button className="apagar" onClick={() => void removerReceita()}>
          ✕
        </button>
      </div>

      <ul className="receita-itens">
        {receita.itens.map((item) => (
          <li key={item.id}>
            <span className="qtd">
              {item.quantidade === null ? (
                <em className="muted">um pouco</em>
              ) : (
                `${item.quantidade.toLocaleString('pt-BR')} ${item.unidade ?? ''}`
              )}
            </span>
            <span>{item.insumoNome ?? item.receitaFilhaNome}</span>
            <span className="muted">{item.custo === null ? '' : dinheiro(item.custo)}</span>
            <button className="apagar" onClick={() => void remover(item.id)}>
              ✕
            </button>
          </li>
        ))}
      </ul>

      <div className="form-linha compacta">
        <input
          className="curto"
          placeholder="Qtd"
          value={qtd}
          onChange={(e) => setQtd(e.target.value)}
        />
        <select value={alvo} onChange={(e) => setAlvo(e.target.value)}>
          <option value="">Adicionar…</option>
          <optgroup label="Insumos">
            {insumos.map((i) => (
              <option key={i.id} value={`insumo:${i.id}`}>
                {i.nome} ({i.unidade})
              </option>
            ))}
          </optgroup>
          {componentes.length > 0 && (
            <optgroup label="Componentes">
              {componentes
                .filter((c) => c.id !== receita.id)
                .map((c) => (
                  <option key={c.id} value={`receita:${c.id}`}>
                    {c.nome}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
        <button onClick={() => void adicionar()}>+</button>
      </div>
    </div>
  )
}

function NovaReceita({
  linhaId,
  recarregar
}: {
  linhaId: number
  recarregar: () => Promise<void>
}): React.JSX.Element {
  const [nome, setNome] = useState('')
  const [tipo, setTipo] = useState<'CAIXA' | 'EMBALAGEM'>('CAIXA')

  const criar = async (): Promise<void> => {
    if (!nome.trim()) return
    await window.api.fabricacao.criarReceita({ linhaId, nome: nome.trim(), tipo })
    setNome('')
    await recarregar()
  }

  return (
    <div className="form-linha compacta">
      <input
        placeholder="Nova receita (ex.: Caixa berço)"
        value={nome}
        onChange={(e) => setNome(e.target.value)}
      />
      <select value={tipo} onChange={(e) => setTipo(e.target.value as 'CAIXA' | 'EMBALAGEM')}>
        <option value="CAIXA">Caixa</option>
        <option value="EMBALAGEM">Embalagem</option>
      </select>
      <button onClick={() => void criar()}>+</button>
    </div>
  )
}
