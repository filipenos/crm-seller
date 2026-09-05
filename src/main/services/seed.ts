import { getAsyncDb } from '../db'
import { criarInsumoAsync } from './insumos'
import { adicionarItemAsync, criarLinhaAsync, criarReceitaAsync } from './receitas'

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

export async function garantirCadastroDeFabricacaoAsync(): Promise<boolean> {
  const db = getAsyncDb()
  const supplies = await db.prepare('SELECT COUNT(*) AS n FROM supplies')
  const lines = await db.prepare('SELECT COUNT(*) AS n FROM production_lines')
  const [supplyCount, lineCount] = await Promise.all([
    supplies.get([]) as Promise<{ n: number }>,
    lines.get([]) as Promise<{ n: number }>
  ])
  if (supplyCount.n > 0 || lineCount.n > 0) return false

  const papel = await criarInsumoAsync({ nome: 'Papel', unidade: 'folha', estoqueMinimo: 100 })
  const cola = await criarInsumoAsync({ nome: 'Cola', unidade: 'ml' })
  const tinta = await criarInsumoAsync({ nome: 'Tinta', unidade: 'ml' })
  const cetim9 = await criarInsumoAsync({
    nome: 'Fita cetim nº9', unidade: 'cm', estoqueMinimo: 500, variantes: ['Azul', 'Amarela']
  })
  const cetim1 = await criarInsumoAsync({
    nome: 'Fita cetim nº1', unidade: 'cm', estoqueMinimo: 500, variantes: ['Azul', 'Amarela']
  })
  const perola = await criarInsumoAsync({ nome: 'Meia pérola', unidade: 'un', estoqueMinimo: 100 })
  const saco = await criarInsumoAsync({ nome: 'Saco', unidade: 'un', estoqueMinimo: 20 })
  const bolha = await criarInsumoAsync({ nome: 'Plástico bolha', unidade: 'm', estoqueMinimo: 20 })
  const saquinho = await criarInsumoAsync({ nome: 'Saquinho individual', unidade: 'un', estoqueMinimo: 50 })
  const etiqueta = await criarInsumoAsync({ nome: 'Etiqueta', unidade: 'un', estoqueMinimo: 20 })
  const laco = await criarReceitaAsync({ linhaId: null, nome: 'Laço', tipo: 'COMPONENTE' })
  await adicionarItemAsync({ receitaId: laco, insumoId: cetim9, quantidade: 26 })
  await adicionarItemAsync({ receitaId: laco, insumoId: cetim1, quantidade: 10 })
  await adicionarItemAsync({ receitaId: laco, insumoId: perola, quantidade: 1 })
  const linha = await criarLinhaAsync('Fabricação padrão')
  for (const [nome, comLaco] of [
    ['Pirâmide', true], ['Milk', true], ['Coração', false],
    ['Maleta quadrada', false], ['Maleta redonda', false]
  ] as const) {
    const recipe = await criarReceitaAsync({ linhaId: linha, nome, tipo: 'CAIXA' })
    await adicionarItemAsync({ receitaId: recipe, insumoId: papel, quantidade: 1 })
    await adicionarItemAsync({ receitaId: recipe, insumoId: cola, quantidade: UM_POUCO })
    await adicionarItemAsync({ receitaId: recipe, insumoId: tinta, quantidade: UM_POUCO })
    if (comLaco) await adicionarItemAsync({ receitaId: recipe, receitaFilhaId: laco, quantidade: 1 })
  }
  const embalagem = await criarReceitaAsync({
    linhaId: linha, nome: 'Embalagem do pedido', tipo: 'EMBALAGEM'
  })
  await adicionarItemAsync({ receitaId: embalagem, insumoId: saco, quantidade: 1 })
  await adicionarItemAsync({ receitaId: embalagem, insumoId: bolha, quantidade: 1 })
  await adicionarItemAsync({ receitaId: embalagem, insumoId: saquinho, quantidade: 3 })
  await adicionarItemAsync({ receitaId: embalagem, insumoId: etiqueta, quantidade: 1 })
  return true
}
