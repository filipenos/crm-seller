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
