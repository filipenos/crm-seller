# Consulta privada na Cloudflare

A versão web é somente leitura. Ela consulta o mesmo Turso usado pelo desktop;
sincronização da Shopee, migrations e operações locais continuam no Electron.

## Endereço

O Worker está preparado para o domínio `crm.filipenos.com`. O deploy não usa
`workers.dev`, reduzindo o risco de existir uma segunda URL sem a proteção do
Cloudflare Access.

## Secrets

No computador de desenvolvimento, autentique o Wrangler uma vez:

```sh
npx wrangler login
```

Depois copie `.env.cloudflare.example` para `.env.cloudflare` e preencha apenas
as duas variáveis do Turso. `CLOUDFLARE_ACCOUNT_ID` e
`CLOUDFLARE_API_TOKEN` podem ficar vazias no deploy local. O arquivo é ignorado
pelo Git, e o deploy envia as credenciais do Turso aos secrets do Worker antes
de publicar:

```sh
npm run deploy:web
```

O token recomendado é restrito ao banco e somente leitura. O frontend nunca
recebe esses valores; apenas o Worker conversa com o Turso.

Para desenvolvimento local, preencha somente as credenciais Turso em
`.dev.vars`. O Wrangler lê esse arquivo automaticamente e ele também é
ignorado pelo Git.

O script aceita as quatro variáveis diretamente do ambiente. No GitHub Actions,
Account ID e API Token serão obrigatórios e poderão vir de GitHub Secrets sem
criar `.env.cloudflare` no runner.

## Cloudflare Access

Antes do deploy, crie uma aplicação Access para `crm.filipenos.com`:

1. Em **Zero Trust > Access > Applications**, crie uma aplicação self-hosted.
2. Use `crm.filipenos.com` como hostname.
3. Configure o Google como provedor de identidade.
4. Crie uma política `Allow` contendo somente os dois e-mails autorizados.
5. Não crie regras públicas ou `Bypass` para o hostname.

O Access deve proteger o site inteiro, incluindo `/api/*`.

## Comandos

```sh
npm run build:web
npm run dev:web
npm run deploy:web
```

O recorte web contém Painel, Pedidos e Fabricação. Os módulos reutilizam os
tipos existentes e expõem somente rotas de leitura; Desempenho e qualquer
sincronização com a Shopee permanecem exclusivos do aplicativo desktop.
