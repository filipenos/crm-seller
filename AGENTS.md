# AGENTS.md

## Banco de dados

- O banco principal é o Turso (`libSQL`) e deve sempre ser tratado como um banco remoto, mesmo durante o desenvolvimento.
- Não implemente caminhos que dependam de SQLite local, acesso síncrono ou baixa latência de disco.
- Minimize viagens de rede: agrupe leituras relacionadas com `queryBatch` e gravações atômicas com `batch`.
- Evite consultas N+1 e atualizações de um campo por chamada. Prefira uma consulta ou atualização parametrizada por operação do usuário.
- Depois de uma mutação, não recarregue dados que não foram afetados. Quando seguro, atualize a interface de forma otimista e confirme em segundo plano.
- Toda operação perceptível deve ser assíncrona, manter a interface responsiva e exibir estado de carregamento ou progresso.
- Considere latência, falhas transitórias e atomicidade em qualquer fluxo que acesse o banco.
- Nunca registre, exponha ou versiona a URL privada, o token ou outros dados do Turso.

## Verificação

- Para mudanças no acesso a dados, conte as chamadas remotas do fluxo e procure reduzi-las antes de considerar a implementação concluída.
- Execute `npm run typecheck`, os testes relevantes e `npm run build`.

## Integração MCP

- O app Electron é a origem das operações; o servidor MCP em `src/main/services/mcpServer.ts` chama os mesmos serviços usados pelo IPC. Não replique regras de pedidos, composição ou estoque no MCP.
- Ao corrigir ou adicionar uma operação de pedidos, agenda, produção, insumos, compras, estoque ou composição, revise a ferramenta MCP correspondente. Adicione ou ajuste a ferramenta e sua documentação quando a operação também fizer sentido fora da interface.
- Não exponha pelo MCP configuração do Turso, sessão da Shopee, cookies, tokens, caminhos locais ou outras credenciais. Valide cada argumento de ferramenta e mantenha consultas limitadas.
- Para alterações no MCP, verifique descoberta, uma chamada válida, entrada inválida e bloqueio de acesso pela rede local sem chave. Registre novas ferramentas em `docs/mcp-chatgpt.md`.
