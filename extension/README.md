# Sessão da Shopee no Chrome

1. Abra `chrome://extensions` e ative **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e selecione esta pasta `extension`.
3. Entre em `https://seller.shopee.com.br/` no Chrome.
4. No CRM Seller, clique em **Usar login do Chrome**.
5. Na primeira vez, abra o ícone da extensão no Chrome e clique em **Conectar ao aplicativo**. Se o Chrome pedir acesso à rede local, autorize. Depois disso, a extensão responde automaticamente; pode levar até 30 segundos.

A extensão só envia os cookies da Shopee para o CRM Seller em `127.0.0.1` quando o aplicativo solicita. O Electron grava a sessão em um perfil local separado da sessão criada pela janela de login do app. Nenhum cookie é enviado à API web ou ao Turso.

Se a sessão expirar, entre novamente na Shopee no Chrome e clique em **Usar login do Chrome** no aplicativo.
