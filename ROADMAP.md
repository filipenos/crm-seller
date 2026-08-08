# Escopo e roadmap — CRM Seller

Documento vivo: o que o app já faz, o que ainda depende de calibração e o que
está planejado. Detalhe técnico das integrações fica no [README](README.md).

## 0. Distribuição (feito)

Desenvolvimento em Ubuntu/macOS, uso em Windows. Instalador gerado por runner
Windows no GitHub Actions a cada tag `v*`, publicado nas Releases; o app
instalado se atualiza sozinho via `electron-updater` (baixa em segundo plano,
instala ao fechar). Detalhes e comandos no [README](README.md#distribuição-desenvolve-no-linuxmac-usa-no-windows).

## 1. O que já existe (funcionando)

- **Pedidos** sincronizados do Seller Center (endpoints confirmados na conta
  real, fluxo de 2 passos) com itens, valor, comprador e prazo de envio.
- **Status interno de produção** (Novo → … → Concluído) com histórico.
- **Pasta por pedido** a partir de templates, com `{NOME}` no nome dos arquivos
  e `pedido-info.txt` gerado.
- **Eventos e linha do tempo** por pedido (aba Atividade, contador de não-vistos).
- **Atualização automática** via GitHub Releases.

## 2. Existe no código, mas ainda não calibrado

Cada um destes tem endpoints *candidatos* (adivinhados) e falha silenciosamente
na sincronização até ser calibrado pelo **Configurações → Diagnóstico das APIs**.

| Área | Situação |
|---|---|
| Chat / mensagens do comprador | webchat tem login próprio; a chamada crua devolve `user_is_unauthorized`. Falta capturar `_uid`/`csrf_token`/`SPC_CDS_CHAT` do contexto da página. |
| Avaliações | endpoints candidatos ainda não confirmados |
| Financeiro (liberação de pagamento) | idem; a escala do valor (micro-unidades vs decimal) precisa ser confirmada no `raw_json` |
| Rastreio logístico | idem |
| Etiqueta (PDF da Shopee) | idem; hoje cai no fallback da etiqueta interna |

## 3. Planejado

### 3.0 Página "Meu trabalho" — a mais usada (próxima a construir)

**Separação que orienta o app inteiro:** a página **Pedidos** é *espelho da
Shopee* — mostra o que a Shopee diz, sem controle nosso. Toda a organização do
trabalho vive numa página separada.

"Meu trabalho" mostra só os pedidos que ainda estão conosco: **entraram e não
foram despachados**, ou seja, tudo que não está enviado — incluindo os que já
têm etiqueta gerada e esperam ida ao ponto de coleta.

É aqui que voltam as etapas de produção configuráveis, a personalização (nome
da criança), as pastas e as ações. A página de Pedidos não tem mais nada disso.

Ordenação natural: prazo de postagem (`ship_by_date`), porque estourar o prazo
gera multa da Shopee.

### 3.1 Anúncios (Shopee Ads) e custo de anúncio por venda

**Objetivo:** saber quanto se gasta em anúncio e quanto disso pesa em cada venda.

- Coletar **gasto por campanha e por dia** (aba Ads do Seller Center — já é alvo
  do diagnóstico, chave `ads`).
- Guardar em tabela própria (`ad_spend`: data, campanha, anúncio/item, gasto,
  impressões, cliques, pedidos e receita atribuídos pela própria Shopee).
- **Atenção de modelagem:** a Shopee atribui conversão por campanha/anúncio num
  período, não pedido a pedido. Então:
  - *Custo direto por pedido* só existe quando a própria Shopee atribui o pedido
    à campanha — usar isso quando vier no relatório;
  - caso contrário, calcular **rateio por período**: gasto do dia ÷ pedidos do
    dia (ou ÷ receita do dia), e deixar explícito na UI que é rateio, não custo
    real daquele pedido.
- Indicadores: gasto do mês, ACOS (gasto ÷ receita atribuída), custo médio por
  pedido, e um alerta quando o ACOS passar de um limite configurável.

### 3.2 Produtos, ficha de fabricação e estoque

**Objetivo:** ter o produto do lado de cá — o que precisa para fabricar, quanto
custa e quanto tem em estoque.

Modelo pretendido (tabelas novas no mesmo SQLite):

- `products` — produto interno: nome, SKU próprio, preço de venda,
  **vínculo com o anúncio da Shopee** (`item_id`/`item_sku`, que já vem em
  `order_items.item_sku`) para casar venda ↔ produto.
- `materials` — insumo: nome, unidade (un, m, kg, folha), custo unitário atual,
  estoque atual, estoque mínimo.
- `product_materials` — a **ficha técnica (BOM)**: quanto de cada insumo entra
  em uma unidade do produto. É daqui que sai o custo de material estimado.
- `production_batches` — ordem/lote de fabricação: produto, quantidade,
  data, custo calculado. Ao concluir: **baixa os insumos** e **entra estoque do
  produto acabado**.
- `stock_movements` — todo movimento (compra de insumo, consumo em produção,
  venda, ajuste manual), para o estoque ser auditável em vez de um número solto.

Fluxos:

- Cadastrar produto → montar a ficha técnica → o custo unitário estimado sai
  automático (Σ insumo × quantidade), com mão de obra/overhead opcionais.
- Registrar compra de insumo → atualiza estoque e custo unitário.
- Fabricar um lote → consome insumo, gera estoque, congela o custo do lote.
- Pedido concluído → baixa estoque do produto acabado (pelo vínculo do SKU).
- Alerta de **estoque mínimo** de insumo e de produto acabado.

### 3.3 Margem por pedido (junta tudo)

Com 3.1 e 3.2 no lugar, cada pedido consegue mostrar:

```
receita (valor do pedido)
− custo de material (ficha técnica × quantidade)
− taxas da Shopee (comissão + frete)      ← vem do financeiro, seção 2
− custo de anúncio (atribuído ou rateado) ← seção 3.1
= margem estimada
```

E o mesmo consolidado por mês, para saber se o negócio está fechando.

### 3.4 Outros itens já levantados

- Enviar mensagens ao cliente pelo app.
- Kanban de produção (arrastar entre status).
- Impressão em lote de etiquetas.

## 4. Ordem sugerida

0. **Distribuição** — feito (seção 0): criar o repo no GitHub e publicar a
   primeira release, para o ciclo de update já valer a partir da v0.1.0.
1. Rodar o **diagnóstico** e calibrar financeiro + avaliações + rastreio
   (destrava "acompanhar pedidos e pagamentos", que é o pedido mais imediato).
2. **Produtos + ficha técnica + estoque** — não depende de nada da Shopee, é
   local, e já dá o custo de fabricação.
3. **Ads** — depende de calibrar os endpoints da aba de anúncios.
4. **Margem por pedido**, que só faz sentido depois de 1–3.
