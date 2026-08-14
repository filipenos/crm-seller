import { getDb } from '../db'
import { criarInsumo } from './insumos'
import { adicionarItem, criarLinha, criarReceita } from './receitas'

/**
 * Cadastro inicial de fabricação.
 *
 * A alternativa era abrir a página vazia e pedir para o usuário digitar a
 * própria oficina antes de ver qualquer coisa funcionar. Como o kit de hoje é
 * sempre o mesmo — cinco modelos, laço na milk e na pirâmide, uma embalagem por
 * pedido —, o app já nasce sabendo disso e o que falta é corrigir, não criar.
 *
 * Só roda em base virgem: mexer em cadastro existente seria ressuscitar o que o
 * usuário apagou de propósito.
 */

/** Sem quantidade certa: entra na lista do que é preciso ter, não no custo. */
const UM_POUCO = null

export function garantirCadastroDeFabricacao(): boolean {
  const db = getDb()
  const jaTem =
    (db.prepare('SELECT COUNT(*) AS n FROM supplies').get() as { n: number }).n > 0 ||
    (db.prepare('SELECT COUNT(*) AS n FROM production_lines').get() as { n: number }).n > 0
  if (jaTem) return false

  const criar = db.transaction(() => {
    const papel = criarInsumo({ nome: 'Papel', unidade: 'folha', estoqueMinimo: 100 })
    const cola = criarInsumo({ nome: 'Cola', unidade: 'ml' })
    const tinta = criarInsumo({ nome: 'Tinta', unidade: 'ml' })
    // As cores ficam como variantes; estas são as que o usuário citou, e o
    // resto se cadastra na tela.
    const cetim9 = criarInsumo({
      nome: 'Fita cetim nº9',
      unidade: 'cm',
      estoqueMinimo: 500,
      variantes: ['Azul', 'Amarela']
    })
    const cetim1 = criarInsumo({
      nome: 'Fita cetim nº1',
      unidade: 'cm',
      estoqueMinimo: 500,
      variantes: ['Azul', 'Amarela']
    })
    const perola = criarInsumo({ nome: 'Meia pérola', unidade: 'un', estoqueMinimo: 100 })
    const saco = criarInsumo({ nome: 'Saco', unidade: 'un', estoqueMinimo: 20 })
    const bolha = criarInsumo({ nome: 'Plástico bolha', unidade: 'm', estoqueMinimo: 20 })
    const saquinho = criarInsumo({ nome: 'Saquinho individual', unidade: 'un', estoqueMinimo: 50 })
    const etiqueta = criarInsumo({ nome: 'Etiqueta', unidade: 'un', estoqueMinimo: 20 })

    // O laço é receita à parte porque duas caixas o usam: assim o cetim é
    // cadastrado uma vez só, e encarecer a fita encarece as duas de uma vez.
    const laco = criarReceita({ linhaId: null, nome: 'Laço', tipo: 'COMPONENTE' })
    adicionarItem({ receitaId: laco, insumoId: cetim9, quantidade: 26 })
    adicionarItem({ receitaId: laco, insumoId: cetim1, quantidade: 10 })
    adicionarItem({ receitaId: laco, insumoId: perola, quantidade: 1 })

    const linha = criarLinha('Fabricação padrão')

    const caixa = (nome: string, comLaco: boolean): void => {
      const id = criarReceita({ linhaId: linha, nome, tipo: 'CAIXA' })
      adicionarItem({ receitaId: id, insumoId: papel, quantidade: 1 })
      adicionarItem({ receitaId: id, insumoId: cola, quantidade: UM_POUCO })
      adicionarItem({ receitaId: id, insumoId: tinta, quantidade: UM_POUCO })
      if (comLaco) adicionarItem({ receitaId: id, receitaFilhaId: laco, quantidade: 1 })
    }

    caixa('Pirâmide', true)
    caixa('Milk', true)
    caixa('Coração', false)
    caixa('Maleta quadrada', false)
    caixa('Maleta redonda', false)

    const embalagem = criarReceita({ linhaId: linha, nome: 'Embalagem do pedido', tipo: 'EMBALAGEM' })
    adicionarItem({ receitaId: embalagem, insumoId: saco, quantidade: 1 })
    adicionarItem({ receitaId: embalagem, insumoId: bolha, quantidade: 1 })
    adicionarItem({ receitaId: embalagem, insumoId: saquinho, quantidade: 3 })
    adicionarItem({ receitaId: embalagem, insumoId: etiqueta, quantidade: 1 })
  })

  criar()
  return true
}
