# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CRM Electron + React + libSQL/Turso para pedidos de caixas personalizadas
vendidas na Shopee. Usa uma réplica embutida sincronizada com o banco do usuário.
Visão de produto e o que está planejado: [README.md](README.md) e
[ROADMAP.md](ROADMAP.md).

**Idioma**: código, comentários, UI e documentação em **português**.
Comentário aqui explica *por que*, não *o que* — a maior parte do código lida
com APIs não documentadas, e o motivo de cada decisão é o que se perde.

**Commits**: mensagem em **inglês**, seguindo
[Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`…). **Nunca** adicione trailer
`Co-Authored-By` — nem o do Claude, nem nenhum outro.

## Comandos

```bash
npm run dev          # electron-vite dev
npm run dev:linux    # idem, com ELECTRON_DISABLE_SANDBOX=1 (Ubuntu)
npm run typecheck    # tsc nos dois projetos (node + web) — rode sempre antes de terminar
npm run build        # só compila (out/)
npm run build:linux  # empacota .AppImage/.deb localmente
```

No Ubuntu com Wayland, o dev costuma precisar de:
`WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 ELECTRON_DISABLE_SANDBOX=1 npm run dev`

O instalador **Windows não é gerado localmente** — sai do GitHub Actions
(`libsql` é nativo). Ver "Distribuição" no README.

## Testes

Não há test runner. O padrão usado para exercitar a lógica do processo main
sem GUI: bundlar com esbuild trocando `electron` por um stub e rodar com o
binário do Electron em modo Node.

```bash
node_modules/.bin/esbuild smoke.ts --bundle --platform=node --format=esm \
  --outfile=smoke.mjs --alias:electron=./electron-stub.js --external:libsql
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
  ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron smoke.mjs
```

Dois detalhes que fazem isso funcionar: `libsql` é compilado para o ABI
do Electron (por isso `ELECTRON_RUN_AS_NODE`, não `node`), e o bundle precisa
de um `node_modules` alcançável a partir da pasta dele (link simbólico serve).
O stub de `electron` devolve respostas canned no `executeJavaScript`, o que
permite testar todo o parsing do `client.ts` de ponta a ponta.

## Arquitetura

Três processos, e o IPC é a única fronteira:

- `src/main/` — todo o acesso a disco, banco e rede. Serviços em
  `services/`, handlers em `ipc.ts`.
- `src/preload/index.ts` — `contextBridge` tipado; `Api` é inferida daqui e
  vira `window.api` no renderer.
- `src/renderer/` — React puro, sem acesso a Node.
- `src/shared/types.ts` — tipos usados pelos três (alias `@shared`).

Ao adicionar uma capacidade, os quatro pontos mudam juntos: serviço → `ipc.ts`
→ `preload/index.ts` → componente.

### Integração Shopee — o ponto delicado

Não é a Open API oficial. O app abre o Seller Center numa `BrowserWindow`
oculta com partition `persist:shopee` e executa `fetch` **dentro da página
logada** (`pageFetchJson` em `services/shopee/session.ts`), então cookies e
anti-CSRF vêm de graça. Consequência: endpoints não são públicos, mudam sem
aviso e o parsing precisa ser tolerante. Todo pedido/mensagem guarda `raw_json`
no banco para diagnóstico.

Três invariantes do cliente — quebrar qualquer uma torna a integração
indiagnosticável:

1. **Erro da Shopee é erro.** As APIs respondem HTTP 200 com `code != 0` no
   corpo; `pageFetchJson` lê o envelope e lança `ShopeeApiError` com código e
   mensagem reais. Sem isso, todo problema vira "resposta vazia".
2. **Um endpoint candidato só vence se produzir dados reconhecíveis.**
   `tryCandidates` (em `client.ts`) segue para o próximo quando o parser
   devolve `null`. Lista legitimamente vazia é detectada
   (`hasEmptyListNamed`) e aceita.
3. **Reconhecimento exige pares de campos** — descrição *e* horário num
   checkpoint, nota *e* pedido numa avaliação. Testar por uma chave só faz
   `findArrayWhere` casar qualquer array da resposta e inventar dados.

Confirmados por captura de rede: pedidos (2 passos,
`search_order_list_index` → `get_order_list_card_list`, lote máximo de 5),
rastreio (`get_logistics_tracking_history?order_id=`), avaliações
(`search_shop_rating_comments_new/` — o sufixo `_new/` e a barra final
importam) e financeiro por pedido
(`v4/accounting/pc/seller_income/income_detail/get_order_income_components`).

Ainda quebrados: **chat** (o webchat tem login próprio; a página de pedidos
chama `POST /webchat/api/coreapi/v1.2/mini/login/sc` antes) e **etiqueta** (os
candidatos dão 404). Cada seção falha isolada no `sync.ts` sem derrubar o
resto. Para descobrir endpoint real: `services/shopee/probe.ts`, exposto em
**Configurações → Diagnóstico das APIs** — foi assim que os quatro acima
saíram de adivinhação para confirmados.

O extrato financeiro traz o total (`ESCROW_AMOUNT`) **dentro da mesma lista**
das parcelas: somar tudo conta o valor duas vezes.

Normalizações que valem para toda resposta da Shopee: `toMs` (timestamps vêm em
segundos) e `toMoney` (valores são micro-unidades inteiras — 7810000 = 78,10).

### Abas do pedido vs. etapas de produção

São dois eixos, e confundi-los é o erro fácil aqui:

- **Aba** (`OrderTab`, derivada): espelha o Seller Center — A enviar ·
  Enviado · Concluído · Cancelado. **O status do card não decide sozinho**:
  "Entregue" e "Pedido Recebido" aparecem em Enviado enquanto o dinheiro não
  sai e em Concluído depois que sai, então quem desempata é
  `escrow_released_at` (`services/tabs.ts`). Foi assim que os números fecharam
  com a conta real: 26 / 19 / 550 / 85.
- **Etapa** (`workflow_stages`, cadastrada pelo usuário): o fluxo de produção
  interno, com ações configuráveis. **Só vale enquanto a aba é A_ENVIAR.**

Dentro de A enviar, `order_ext_info.logistics_status` separa o que já pode ir
ao ponto de coleta: **1 = etiqueta gerada**, 9 = aguardando, 2 = enviado.

Cancelados ficam em página própria, como na Shopee, e não entram na listagem
nem na contagem de "Todos".

### Sincronização e o dump local

O botão Sincronizar busca `syncPageCount` páginas de 40 (padrão 2 — o que muda
no dia a dia); **Configurações → Sincronizar tudo** percorre a base inteira.
Cada card é gravado cru em `userData/pedidos-json/<order_id>.json`, e
**Reprocessar salvos** reaplica o parsing aos 680 sem uma requisição. Sempre
que aprender a ler um campo novo, reprocesse em vez de rebaixar tudo — foi
assim que o código da etiqueta foi descoberto e aplicado.

O índice (`search_order_list_index`) devolve só ids, mas traz
`pagination.total` — dá para saber o tamanho da base numa requisição.

### Produtos e fabricação

O catálogo **não depende de sincronizar nada**: cada item de pedido carrega
`item_id` e `model_id` da Shopee (o `item_sku` guardava o `item_id` com nome
errado, e a migração 13 corrigiu isso nos 706 itens). `recomporCatalogoDosPedidos`
reconstrói produtos e variações da base local, sem uma requisição — roda na
abertura do app e a cada sincronização. O endpoint de catálogo
(`fetchProducts`) ainda é candidato, não confirmado por captura; quando falha,
a página continua de pé.

A fabricação tem três peças, e confundi-las é o erro fácil:

- **Insumo** com **variantes de cor**. A receita pede "26cm de fita nº9" sem
  cor — quem decide é o tema —, mas estoque e preço pago são de cada cor. Na
  baixa automática, sai da variante com mais estoque.
- **Receita**, que pede insumos *e outras receitas*: o laço é uma receita, e a
  caixa milk pede um laço. Quantidade `NULL` é "um pouco" (cola, tinta): entra
  na lista, fica fora do custo. Por isso todo custo é **piso**, e `incertos`
  diz quanto ficou de fora.
- **Linha de fabricação**, o conjunto de receitas de caixa; o produto aponta
  para ela (`products.line_id`, NULL = a padrão).

O kit vendido **não é cadastrado**: a variação já diz o tamanho ("20 peças / 4
de cada modelo"), então as caixas por modelo saem de `peças ÷ receitas CAIXA da
linha`. A embalagem entra uma vez por pedido.

Estoque é **saldo de `stock_moves`**, nunca um contador. A baixa automática roda
a cada sincronização sobre os pedidos com evento "postado", com idempotência
pelo `ref` único (`pedido:<order_sn>:<variant_id>`). Dois detalhes que já
morderam:

1. **`estoqueDesde`** (chave em `settings`, gravada na primeira execução) limita
   a baixa ao que foi despachado depois que o controle começou. Sem isso a
   primeira baixa desce sobre 550 pedidos antigos e o estoque nasce centenas de
   unidades negativo.
2. O alerta de "está acabando" só vale para insumo **já comprado alguma vez** —
   senão um cadastro novo grita que tudo acabou.

### Banco

Réplica libSQL em `app.getPath('userData')`, sincronizada com o Turso. O
Platform API Token provisiona o banco em `db/tursoPlatform.ts` e é descartado;
URL e token restrito vêm de `db/config.ts`, persistidos com `safeStorage`. Migrações são
um array de strings em `db/migrations.ts` versionado por `PRAGMA user_version`:
**só acrescente ao final**, nunca edite ou reordene as existentes. As variáveis
`TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` substituem a configuração local.

O banco e a loja Shopee são pareados por `settings.shopeeShopId`. Qualquer fluxo
que grave dados vindos da Shopee deve chamar `assertCurrentShopeeAccount()`
antes da primeira escrita. Nunca ofereça troca silenciosa desse vínculo.

### Atualização automática

`electron-updater` com feed nas Releases do GitHub; tag `v*` dispara o workflow
que compila no Windows e publica. O `electron-builder` resolve o repositório
pelo **remote do git** — sem remote ele gera um `app-update.yml` sem provider e
o app instalado nunca se atualiza, sem erro no build (o workflow tem um passo
que falha nesse caso). Em dev o updater não roda.
