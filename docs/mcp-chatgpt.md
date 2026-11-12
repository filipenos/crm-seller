# Integração do CRM Seller com ChatGPT

O app Electron executa o servidor MCP enquanto estiver aberto. O servidor chama os mesmos serviços de pedidos, produção, insumos, estoque e composição usados pela interface. O banco Turso e a sessão Shopee permanecem configurados apenas no app.

## Endereços

- No próprio computador: `http://127.0.0.1:38765/mcp`.
- Na rede local: ative **Configurações → ChatGPT / MCP → Permitir acesso pela rede local**. O app mostra os endereços `http://IP:38766/mcp` e uma chave. O cliente MCP deve enviar `Authorization: Bearer CHAVE` em cada pedido.
- O acesso pela rede fica desativado por padrão. Não encaminhe a porta 38766 no roteador nem publique essa chave.
- Se o outro computador não alcançar o endereço da rede, permita a porta TCP 38766 somente na rede privada do Windows. A chave continua obrigatória.

## ChatGPT para Windows e macOS

No CRM Seller, abra **Configurações → ChatGPT / MCP** e clique em **Instalar neste computador**. O aplicativo registra `crm_seller` no arquivo `~/.codex/config.toml` do usuário e mostra o caminho exato na tela. Feche e abra o ChatGPT; digite `/mcp` no campo de mensagem para conferir a conexão. O CRM Seller precisa estar aberto. Não há arquivo de plugin para abrir com duplo clique. [Documentação oficial](https://learn.chatgpt.com/docs/extend/mcp).

Também é possível configurar manualmente em **Configurações → Servidores MCP → Adicionar servidor**, escolhendo **Streamable HTTP** e usando `http://127.0.0.1:38765/mcp`.

Se o ChatGPT roda em outro computador da mesma rede, ative o acesso LAN no CRM Seller e use o endereço `http://IP:38766/mcp` mostrado na tela. Configure a chave como token Bearer no cliente MCP. O endereço `localhost` sempre aponta para o próprio computador onde o ChatGPT está rodando.

Neste ambiente de desenvolvimento, o servidor já foi registrado com `codex mcp add crm_seller --url http://127.0.0.1:38765/mcp`. A configuração é local a esta máquina; o Windows e o Mac precisam ser configurados separadamente.

O ChatGPT na web usa um caminho diferente, com um endpoint HTTPS alcançável ou um [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Ele não faz parte da instalação desktop descrita aqui.

## Ferramentas

As consultas cobrem visão do dia, agenda, relatório gerencial, pedidos, produtos, composição, insumos, compras, movimentos de estoque, fluxos de produção e estado da Shopee. As ações permitem editar dados de pedidos, avançar etapas, registrar compras, ajustar estoque, manter a composição e iniciar sincronização.

| Área | Ferramentas |
| --- | --- |
| Dia e relatórios | `visao_do_dia`, `agenda_trabalho`, `trabalho_atual`, `selecionar_trabalho`, `relatorio_gerencial` |
| Pedidos | `listar_pedidos`, `detalhar_pedido`, `definir_nome_crianca`, `anotar_pedido`, `definir_status_pedido`, `atualizar_rastreio_pedido`, `atualizar_pagamento_pedido` |
| Catálogo e produção | `produtos`, `fluxos_producao`, `producao_do_pedido`, `avancar_producao` |
| Composição | `composicao`, `criar_item_composicao`, `atualizar_item_composicao`, `remover_item_composicao`, `definir_parte_composicao`, `remover_parte_composicao`, `criar_variante_composicao`, `renomear_variante_composicao`, `remover_variante_composicao`, `criar_tamanho_kit`, `atualizar_tamanho_kit`, `remover_tamanho_kit`, `registrar_compra_composicao`, `atualizar_compra_composicao`, `remover_compra_composicao`, `prever_producao`, `registrar_lote_producao`, `ajustar_estoque_composicao` |
| Insumos e estoque | `insumos`, `criar_insumo`, `atualizar_insumo`, `criar_variante_insumo`, `renomear_variante_insumo`, `compras`, `registrar_compra_insumo`, `movimentos_estoque`, `ajustar_estoque_insumo` |
| Shopee | `estado_sincronizacao`, `previa_sincronizacao_pendente`, `sincronizar_pedidos` |

`sincronizar_pedidos` retorna assim que inicia a tarefa. Use `estado_sincronizacao` para acompanhar o progresso ou a falha. A sincronização usa a sessão Shopee do app; se ela cair, reconecte pelo app.
A agenda e o trabalho atual compartilham a mesma seleção de pedidos no Turso.
`relatorio_gerencial` retorna `cancelamentos` e `dias[].cancelados` separadamente das vendas válidas. Valores de cancelados sem extrato são estimados pelo card da Shopee e podem incluir frete.
Se uma sincronização já estiver em andamento no app ou no MCP, uma nova chamada é recusada com `iniciado: false` e um motivo.

Configuração do banco, login da Shopee, credenciais e arquivos locais não são ferramentas MCP. Operações sensíveis continuam no app.

Ao alterar funcionalidades do app, revise `src/main/services/mcpServer.ts` e este documento para manter as ferramentas alinhadas com os serviços usados pelo IPC. Teste as ferramentas com o [MCP Inspector](https://github.com/modelcontextprotocol/inspector) antes de distribuir uma atualização.
