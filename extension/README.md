# Sessão da Shopee no Chrome

1. No CRM Seller, clique em **Abrir pasta da extensão do Chrome**. A versão instalada inclui essa pasta.
2. Abra `chrome://extensions` no perfil usado para acessar a Shopee e ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta aberta pelo aplicativo.
4. Entre em `https://seller.shopee.com.br/` no Chrome.
5. No CRM Seller, clique em **Usar login do Chrome**.
6. Na primeira vez, abra o ícone da extensão no Chrome e clique em **Conectar ao aplicativo**. Se o Chrome pedir acesso à rede local, autorize. Depois disso, a extensão responde automaticamente; pode levar até 30 segundos.

A extensão só envia os cookies da Shopee para o CRM Seller em `127.0.0.1` quando o aplicativo solicita. O Electron grava a sessão em um perfil local separado da sessão criada pela janela de login do app. Nenhum cookie é enviado à API web ou ao Turso.

Se a sessão expirar, entre novamente na Shopee no Chrome e clique em **Usar login do Chrome** no aplicativo.
