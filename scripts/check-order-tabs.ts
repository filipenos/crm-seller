import assert from 'node:assert/strict'
import { deriveTab, tabFromShopeeSource } from '../src/main/services/tabs'

assert.equal(tabFromShopeeSource('To Ship', 'ENVIADO'), 'ENVIADO')
assert.equal(tabFromShopeeSource('Entregue', 'ENVIADO'), 'ENVIADO')
assert.equal(tabFromShopeeSource('Enviado', 'A_ENVIAR'), 'A_ENVIAR')
assert.equal(tabFromShopeeSource('Entregue', null), 'CONCLUIDO')
assert.equal(tabFromShopeeSource('Não pago', null), 'NAO_PAGO')
assert.equal(tabFromShopeeSource('Cancelado', null), 'CANCELADO')
assert.equal(deriveTab({ shopeeStatus: 'Unpaid', escrowReleasedAt: null }), 'NAO_PAGO')

console.log('Abas de pedidos validadas.')
