# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CRM local (Electron + React + better-sqlite3) para pedidos de caixas
personalizadas vendidas na Shopee. Roda só na máquina do usuário, sem servidor.
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
(`better-sqlite3` é nativo). Ver "Distribuição" no README.

## Testes

Não há test runner. O padrão usado para exercitar a lógica do processo main
sem GUI: bundlar com esbuild trocando `electron` por um stub e rodar com o
binário do Electron em modo Node.

```bash
node_modules/.bin/esbuild smoke.ts --bundle --platform=node --format=esm \
  --outfile=smoke.mjs --alias:electron=./electron-stub.js --external:better-sqlite3
CRM_DB_PATH=/tmp/test.db ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron smoke.mjs
```

Dois detalhes que fazem isso funcionar: `better-sqlite3` é compilado para o ABI
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

Só **pedidos** usa endpoints confirmados (fluxo de 2 passos,
`search_order_list_index` → `get_order_list_card_list`, lote máximo de 5).
Chat, avaliações, financeiro, rastreio e etiqueta ainda são candidatos
adivinhados — falham por seção no `sync.ts` sem derrubar o resto. Para
descobrir os reais: `services/shopee/probe.ts`, exposto em
**Configurações → Diagnóstico das APIs**.

Normalizações que valem para toda resposta da Shopee: `toMs` (timestamps vêm em
segundos) e `toMoney` (valores são micro-unidades inteiras — 7810000 = 78,10).

### Banco

SQLite em `app.getPath('userData')`, WAL. Migrações são um array de strings em
`db/migrations.ts` versionado por `PRAGMA user_version`: **só acrescente ao
final**, nunca edite ou reordene as existentes. `CRM_DB_PATH` sobrepõe o
caminho (é o que permite rodar fora do Electron).

### Atualização automática

`electron-updater` com feed nas Releases do GitHub; tag `v*` dispara o workflow
que compila no Windows e publica. O `electron-builder` resolve o repositório
pelo **remote do git** — sem remote ele gera um `app-update.yml` sem provider e
o app instalado nunca se atualiza, sem erro no build (o workflow tem um passo
que falha nesse caso). Em dev o updater não roda.
