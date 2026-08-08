# CRM Seller

CRM local (Windows, macOS e Linux) para gerenciar pedidos personalizados
vendidos na Shopee. Electron + Node + React + SQLite — tudo roda na sua
máquina, sem servidor.

## O que faz

- **Sincroniza pedidos da Shopee** (Seller Center) e acompanha cada um com um
  **status interno de produção**: Novo → Aguardando info → Criar arquivos →
  Pronto p/ imprimir → Impresso → Embalado → Enviado → Concluído.
- **Pasta por pedido**: cria `Pedidos/<nº do pedido> - <NomeDaCriança>` copiando
  o conteúdo da pasta de templates. Arquivos com `{NOME}` no nome são renomeados
  com o nome da criança. Um `pedido-info.txt` é gerado com itens, nome e
  mensagens do cliente.
- **Eventos e linha do tempo**: cada novidade vinda da Shopee (rastreio,
  avaliação, pagamento) vira um evento na aba **Atividade** (com contador de
  não-vistos na barra lateral) e na linha do tempo do pedido. A tabela mostra
  ✅ entregue, ⭐ nota e 💰 pago, e tem o filtro **“Aguardando pagamento”**
  (entregues cujo dinheiro ainda não caiu).
- **Mensagens do cliente** por pedido (é lá que vem o nome da criança) — com
  botão "usar como nome" para preencher a personalização.
- **Etiqueta**: baixa o documento de envio da Shopee (PDF) para a pasta do
  pedido; se não conseguir, gera uma etiqueta interna de produção 100×150mm.

### Estado de cada integração

Só os pedidos usam endpoints **confirmados** na conta real. O resto tem
endpoints candidatos (adivinhados) e precisa ser calibrado com o diagnóstico —
até lá, essas seções falham na sincronização sem quebrar o app: o erro aparece
no status da sincronização e o que já está no banco continua valendo.

| Integração | Estado |
|---|---|
| Pedidos + itens | ✅ confirmado |
| Rastreio logístico | ✅ `get_logistics_tracking_history?order_id=` |
| Avaliações | ✅ `search_shop_rating_comments_new/` |
| Financeiro por pedido | ✅ `seller_income/income_detail/get_order_income_components` — traz receita líquida, taxas e a liberação do pagamento |
| Mensagens / chat | ❌ o webchat tem login próprio (`user_is_unauthorized`). Pista: a página de pedidos chama `POST /webchat/api/coreapi/v1.2/mini/login/sc` antes |
| Etiqueta em PDF da Shopee | ❌ candidatos respondem 404; falta rodar o diagnóstico na página de envio |

Planejado (anúncios/ACOS, cadastro de produto com ficha de fabricação, estoque
e margem por pedido): ver **[ROADMAP.md](ROADMAP.md)**.

### Diagnóstico das APIs (como calibrar)

Em **Configurações → Diagnóstico das APIs da Shopee**, o app abre as páginas do
Seller Center em segundo plano, anota todas as chamadas de API que elas fazem —
com o corpo dos POSTs — e repete as de leitura para guardar uma amostra da
resposta. O resultado vai para `userData/debug/probe-<data>/`:

- `RESUMO.md` — as chamadas por página, com ★ nas candidatas;
- `requests.json` — tudo que foi capturado;
- `samples.json` — a resposta de cada candidata.

Com isso em mãos, ajuste os endpoints em
`src/main/services/shopee/client.ts`. Chamadas que aparentem alterar algo
(`update`, `create`, `cancel`, `send`…) nunca são repetidas.

## Rodando em desenvolvimento

```bash
npm install
npm run dev
```

**No Ubuntu**, o Electron em modo dev esbarra na restrição de sandbox do
sistema ("The SUID sandbox helper binary was found, but is not configured
correctly"). Duas saídas:

```bash
# opção 1 — atalho que desabilita o sandbox só no dev local
npm run dev:linux

# opção 2 — corrigir a permissão uma vez (aí `npm run dev` funciona normal)
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Os instaladores (.deb/AppImage/NSIS/dmg) não têm esse problema — a permissão
é configurada na instalação.

## Distribuição: desenvolve no Linux/Mac, usa no Windows

O desenvolvimento é em Ubuntu/macOS e o uso é em Windows. Como o
`better-sqlite3` é um módulo nativo, o instalador Windows **não sai de uma
máquina Linux/Mac** — ele é gerado por um runner Windows no GitHub Actions.
Você instala **uma vez**; dali em diante o app se atualiza sozinho.

```
git push --follow-tags (tag v*)
        ↓
GitHub Actions (windows-latest): npm ci → typecheck → build:win → publish
        ↓
GitHub Release: CRM Seller Setup <versão>.exe + latest.yml
        ↓
app instalado: verifica ao abrir e a cada 6h, baixa em segundo plano,
               instala ao fechar (ou no botão "Reiniciar e instalar")
```

### Publicar uma versão nova

```bash
npm version 0.2.0
git push --follow-tags
```

`npm version` sobe a `version` do `package.json`, faz o commit e cria a tag
`v0.2.0`; o push da tag dispara o workflow
[`.github/workflows/release.yml`](.github/workflows/release.yml), que compila e
publica a release. **A tag precisa casar com a `version`** — é assim que o
`latest.yml` fica coerente e o app reconhece a atualização.

### Como a atualização chega ao usuário

- `electron-updater` consulta o repositório gravado no instalador
  (`app-update.yml`, gerado pela config `publish` do `electron-builder`).
- Baixa em segundo plano e **instala quando o app é fechado**
  (`autoInstallOnAppQuit`). O banner "Reiniciar e instalar agora" antecipa.
- O estado aparece em **Configurações → Atualizações**; o campo de repositório
  ali é só um override opcional (vazio = usa o do instalador).
- O NSIS é **por usuário** (`perMachine: false`, pasta fixa) justamente para a
  atualização se instalar sem pedir permissão de administrador.
- **Em desenvolvimento nada disso roda** — só o app empacotado se atualiza.

> ⚠️ Duas armadilhas que deixam o app instalado sem nunca se atualizar, as
> duas sem erro nenhum no build:
>
> - O `electron-builder` descobre o repositório pelo *remote* do git. Sem
>   remote, ele gera um instalador **sem feed** — o workflow tem um passo que
>   falha nesse caso.
> - Por padrão ele publica a release como **rascunho**, que o
>   `electron-updater` não enxerga. Por isso a config tem
>   `publish.releaseType: release`.

**Primeira instalação no Windows**: o app não é assinado, então o SmartScreen
mostra "Windows protegeu o computador" → *Mais informações* → *Executar assim
mesmo*. Isso é só na primeira vez; as atualizações seguintes são silenciosas.

### Builds locais (opcional)

Para testar empacotamento na sua máquina — sem publicar:

| Sistema | Comando | Gera |
|---|---|---|
| Linux (Ubuntu) | `npm run build:linux` | `.AppImage` + `.deb` |
| macOS | `npm run build:mac` (precisa do Xcode CLT) | `.dmg` + `.zip` |

O `npm install` recompila o `better-sqlite3` para a plataforma local
(`postinstall`). No macOS o app não é assinado: na primeira abertura, botão
direito → **Abrir**, ou `xattr -dc "/Applications/CRM Seller.app"`.

## Onde ficam os dados e configurações

Tudo (banco SQLite com pedidos, mensagens e configurações) fica no diretório
de dados padrão do usuário em cada sistema — `app.getPath('userData')`:

| Sistema | Caminho |
|---|---|
| Windows | `%APPDATA%\crm-seller\` |
| macOS | `~/Library/Application Support/crm-seller/` |
| Linux | `~/.config/crm-seller/` |

A sessão da Shopee fica na subpasta `Partitions/shopee` do mesmo diretório.
Para backup, basta copiar a pasta inteira; para "resetar" o app, apague-a.

## Primeiro uso

1. Abra **Configurações** e clique em **Conectar / abrir Seller Center**.
   Faça login na sua conta Shopee e feche a janela (a sessão fica salva).
2. Escolha a **pasta raiz dos pedidos** e a **pasta de templates**.
3. Clique em **Sincronizar** na barra lateral.

### Templates

Coloque na pasta de templates os arquivos-base de cada pedido. Use `{NOME}` no
nome do arquivo para ser substituído pelo nome da criança, ex.:
`Caixa {NOME}.cdr` → `Caixa Helena.cdr`. Subpastas também são copiadas.

## Arquitetura

```
src/
  shared/types.ts      # tipos compartilhados (status, pedido, mensagem…)
  main/                # "backend" (processo main do Electron)
    db/                # better-sqlite3 + migrações (user_version)
    services/
      orders.ts        # repositório de pedidos + workflow de status
      messages.ts      # conversas e mensagens
      folders.ts       # pasta por pedido + templates {NOME}
      labels.ts        # etiqueta Shopee (AWB) ou interna (printToPDF)
      settings.ts      # configurações persistidas no SQLite
      shopee/
        session.ts     # login no Seller Center + fetch na página logada
        client.ts      # APIs internas do Seller Center (parsing tolerante)
        sync.ts        # sincronização + agendador
        probe.ts       # diagnóstico: descobre os endpoints reais
    ipc.ts             # handlers IPC
  preload/index.ts     # ponte tipada (contextBridge) → window.api
  renderer/            # UI React (Pedidos, Mensagens, Configurações)
```

### Como funciona a conexão com a Shopee

Não usamos a Open API oficial (exige aprovação de app). O app abre o Seller
Center numa janela do Electron com sessão persistente; as chamadas às APIs
internas são executadas **no contexto da página logada**, então cookies e
tokens ficam corretos automaticamente. Esses endpoints não são públicos e podem
mudar — por isso o cliente tenta múltiplos endpoints candidatos, faz parsing
tolerante a variações e guarda o JSON bruto de cada pedido/mensagem no banco
(`raw_json`) para diagnóstico e ajuste. Se a Shopee mudar algo, ajuste apenas
`src/main/services/shopee/client.ts`.

Duas regras que o cliente segue e valem manter ao mexer nele:

- **Erro da Shopee é erro, não resposta vazia.** As APIs internas respondem
  HTTP 200 com `code != 0` no corpo; `pageFetchJson` lê esse envelope e lança
  `ShopeeApiError` com o código e a mensagem reais (sessão expirada vira uma
  mensagem específica pedindo login). Sem isso, todo problema virava
  “resposta sem X” e não dava para diagnosticar.
- **Um candidato só “vence” se produzir dados reconhecíveis.** Se o endpoint
  responde mas nada é parseado, o cliente segue para o próximo candidato em vez
  de devolver lista vazia. Lista legitimamente vazia (conversa sem mensagens) é
  detectada e aceita. Os testes de reconhecimento pedem pares de campos
  (descrição **e** horário num checkpoint, nota **e** pedido numa avaliação)
  para não casar um array qualquer da resposta.

### Banco de dados

SQLite no diretório de dados do app (`app.getPath('userData')`): no Windows
`%APPDATA%/crm-seller`, no macOS `~/Library/Application Support/crm-seller`,
no Linux `~/.config/crm-seller`. Journal em WAL. Migrações via
`PRAGMA user_version` em `src/main/db/migrations.ts` — para alterar o schema,
adicione uma nova entrada ao array `migrations`.

## Smoke test do backend

A lógica de banco/pastas roda fora do GUI (variável `CRM_DB_PATH`), o que
permite testar sem abrir janela. Ver histórico do projeto para o script de
exemplo.

## Roadmap

Em **[ROADMAP.md](ROADMAP.md)**: calibrar as integrações pendentes, gasto com
anúncios e ACOS, cadastro de produto com ficha de fabricação, controle de
estoque de insumos, margem por pedido, kanban de produção, envio de mensagens e
impressão em lote.
