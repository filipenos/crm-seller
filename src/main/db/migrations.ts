import type Database from 'libsql'

const migrations: string[] = [
  // 1 — schema inicial
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE orders (
    order_sn TEXT PRIMARY KEY,
    shopee_order_id TEXT,
    shopee_status TEXT,
    internal_status TEXT NOT NULL DEFAULT 'NOVO',
    buyer_username TEXT,
    buyer_name TEXT,
    total_amount REAL,
    currency TEXT,
    child_name TEXT,
    note TEXT,
    tracking_number TEXT,
    ship_by_date INTEGER,
    folder_path TEXT,
    label_path TEXT,
    created_at_shopee INTEGER,
    updated_at_shopee INTEGER,
    synced_at INTEGER,
    raw_json TEXT
  );
  CREATE INDEX idx_orders_internal_status ON orders(internal_status);
  CREATE INDEX idx_orders_buyer ON orders(buyer_username);

  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_sn TEXT NOT NULL REFERENCES orders(order_sn) ON DELETE CASCADE,
    item_name TEXT NOT NULL,
    model_name TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    image_url TEXT,
    item_sku TEXT
  );
  CREATE INDEX idx_order_items_order ON order_items(order_sn);

  CREATE TABLE conversations (
    conversation_id TEXT PRIMARY KEY,
    buyer_username TEXT NOT NULL,
    buyer_avatar TEXT,
    last_message_at INTEGER,
    last_message_preview TEXT,
    unread_count INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT
  );
  CREATE INDEX idx_conversations_buyer ON conversations(buyer_username);

  CREATE TABLE messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    order_sn TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    content_type TEXT NOT NULL DEFAULT 'text',
    content TEXT NOT NULL DEFAULT '',
    image_url TEXT,
    created_at INTEGER NOT NULL,
    raw_json TEXT
  );
  CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX idx_messages_order ON messages(order_sn);

  CREATE TABLE status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_sn TEXT NOT NULL REFERENCES orders(order_sn) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    changed_at INTEGER NOT NULL
  );
  CREATE INDEX idx_status_history_order ON status_history(order_sn);
  `,
  // 2 — eventos da Shopee (rastreio, avaliação, pagamento) + campos no pedido
  `
  ALTER TABLE orders ADD COLUMN logistics_status TEXT;
  ALTER TABLE orders ADD COLUMN delivered_at INTEGER;
  ALTER TABLE orders ADD COLUMN rating_star INTEGER;
  ALTER TABLE orders ADD COLUMN rating_comment TEXT;
  ALTER TABLE orders ADD COLUMN rated_at INTEGER;
  ALTER TABLE orders ADD COLUMN escrow_amount REAL;
  ALTER TABLE orders ADD COLUMN escrow_released_at INTEGER;

  CREATE TABLE order_events (
    event_key TEXT PRIMARY KEY,
    order_sn TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('logistics', 'rating', 'finance', 'status')),
    description TEXT NOT NULL,
    happened_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT
  );
  CREATE INDEX idx_order_events_order ON order_events(order_sn, happened_at);
  CREATE INDEX idx_order_events_seen ON order_events(seen, happened_at);
  `,
  // 3 — fase logística derivada dos checkpoints (guarda a mais avançada já vista)
  `
  ALTER TABLE orders ADD COLUMN logistics_phase TEXT;
  CREATE INDEX idx_orders_logistics_phase ON orders(logistics_phase);
  `,
  // 4 — etapas de produção cadastráveis, no lugar da lista fixa no código.
  //     As etapas antigas viram linhas aqui para nada se perder; as que
  //     descreviam transporte (Enviado/Concluído) saem, porque isso agora é
  //     fase logística, não etapa nossa.
  `
  CREATE TABLE workflow_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    color TEXT
  );
  CREATE TABLE stage_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_id INTEGER NOT NULL REFERENCES workflow_stages(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE INDEX idx_stage_actions_stage ON stage_actions(stage_id, position);

  ALTER TABLE orders ADD COLUMN stage_id INTEGER REFERENCES workflow_stages(id);
  CREATE INDEX idx_orders_stage ON orders(stage_id);

  INSERT INTO workflow_stages (id, name, position, color) VALUES
    (1, 'Novo',              1, '#64748b'),
    (2, 'Aguardando info',   2, '#f59e0b'),
    (3, 'Criar arquivos',    3, '#3b82f6'),
    (4, 'Pronto p/ imprimir',4, '#8b5cf6'),
    (5, 'Impresso',          5, '#06b6d4'),
    (6, 'Embalado',          6, '#22c55e');

  INSERT INTO stage_actions (stage_id, label, kind, position) VALUES
    (2, 'Abrir conversa',     'ABRIR_MENSAGENS', 1),
    (2, 'Avançar etapa',      'AVANCAR',         2),
    (3, 'Criar pasta',        'CRIAR_PASTA',     1),
    (3, 'Abrir pasta',        'ABRIR_PASTA',     2),
    (3, 'Avançar etapa',      'AVANCAR',         3),
    (4, 'Abrir pasta',        'ABRIR_PASTA',     1),
    (4, 'Gerar etiqueta',     'GERAR_ETIQUETA',  2),
    (4, 'Avançar etapa',      'AVANCAR',         3),
    (1, 'Avançar etapa',      'AVANCAR',         1),
    (5, 'Avançar etapa',      'AVANCAR',         1),
    (6, 'Avançar etapa',      'AVANCAR',         1);

  UPDATE orders SET stage_id = CASE internal_status
    WHEN 'NOVO'                 THEN 1
    WHEN 'AGUARDANDO_INFO'      THEN 2
    WHEN 'CRIAR_ARQUIVOS'       THEN 3
    WHEN 'PRONTO_PARA_IMPRIMIR' THEN 4
    WHEN 'IMPRESSO'             THEN 5
    ELSE 6
  END;
  `,
  // 5 — chat e etiqueta saíram do app: o webchat exige login próprio e os
  //     endpoints de etiqueta respondem 404. As ações que dependiam deles
  //     viravam botões que só sabiam falhar. As tabelas de conversa ficam:
  //     são histórico, e migração não se reescreve.
  `
  DELETE FROM stage_actions WHERE kind IN ('GERAR_ETIQUETA', 'ABRIR_MENSAGENS');
  `,
  // 6 — código numérico de progresso de envio. Já vinha no card e era
  //     descartado; é ele que separa "etiqueta gerada" (1) de "aguardando" (9).
  `
  ALTER TABLE orders ADD COLUMN logistics_code INTEGER;
  CREATE INDEX idx_orders_logistics_code ON orders(logistics_code);
  `,
  // 7 — campos que o card já trazia e a listagem precisa para ser útil:
  //     o texto que a Shopee usa para explicar o estado, forma de pagamento,
  //     transportadora, destino e o link do pedido no Seller Center.
  `
  ALTER TABLE orders ADD COLUMN status_description TEXT;
  ALTER TABLE orders ADD COLUMN payment_method TEXT;
  ALTER TABLE orders ADD COLUMN carrier TEXT;
  ALTER TABLE orders ADD COLUMN shipping_city TEXT;
  ALTER TABLE orders ADD COLUMN shopee_url_path TEXT;
  `,
  // 8 — o pacote tem mais de um código: o da transportadora (BR…/AP…BR dos
  //     Correios) e o interno da Shopee (OFG…). O QR da etiqueta traz um
  //     deles, então os dois precisam ser pesquisáveis.
  `
  ALTER TABLE orders ADD COLUMN package_number TEXT;
  CREATE INDEX idx_orders_package_number ON orders(package_number);
  `,
  // 9 — campos **nossos**, calculados quando o pedido entra.
  //     Antes a aba era recalculada em toda leitura e o filtro de recebimentos
  //     repetia a mesma regra em SQL com LIKE nos textos da Shopee: duas cópias
  //     da mesma decisão, que podiam divergir sem ninguém notar. Agora a
  //     tradução acontece uma vez, na fronteira, e o resto do app só lê daqui.
  `
  ALTER TABLE orders ADD COLUMN tab TEXT;
  ALTER TABLE orders ADD COLUMN ready_to_post INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_orders_tab ON orders(tab);
  `,
  // 10 — extrato financeiro por pedido, com as taxas separadas.
  //      Colunas com nomes nossos: os campos da Shopee (MERCHANDISE_SUBTOTAL,
  //      FEES_AND_CHARGES…) são traduzidos no client e não chegam até aqui. O
  //      raw_json fica junto para que uma taxa nova que a Shopee invente possa
  //      ser identificada depois, sem rebaixar centenas de extratos de novo.
  `
  CREATE TABLE order_income (
    order_sn TEXT PRIMARY KEY REFERENCES orders(order_sn) ON DELETE CASCADE,
    valor_produtos REAL,
    valor_frete REAL,
    desconto_cupons REAL,
    taxa_comissao REAL,
    taxa_servico REAL,
    outras_taxas REAL,
    valor_recebido REAL,
    recebido_em INTEGER,
    atualizado_em INTEGER NOT NULL,
    raw_json TEXT
  );
  `,
  // 11 — data prevista de liberação. O `released_time` da Shopee guarda a
  //      **previsão** enquanto o dinheiro não sai, então tratá-lo como
  //      "recebido" mandava pedido não pago para a aba Concluído.
  `
  ALTER TABLE order_income ADD COLUMN previsto_para INTEGER;
  `,
  // 12 — quantas caixas o item representa. A variação diz "20 peças / 4 de
  //      cada modelo", então o número está no texto; guardar o valor lido
  //      permite somar caixas vendidas sem reinterpretar string em consulta.
  `
  ALTER TABLE order_items ADD COLUMN pecas INTEGER;
  `,
  // 13 — catálogo de produtos, e o vínculo pedido → produto.
  //      Os ids já vinham no card: o `item_sku` guardava, com nome errado, o
  //      `item_id` da Shopee nos 706 itens vendidos. Renomear para o que é
  //      permite ligar pedido a produto sem uma requisição; o `model_id`
  //      (variação) sai do reprocessamento dos JSONs salvos.
  `
  CREATE TABLE products (
    item_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_url TEXT,
    price REAL,
    stock INTEGER,
    active INTEGER,
    -- Linha de fabricação. NULL = a padrão, que é o caso de quase todo tema.
    line_id INTEGER,
    synced_at INTEGER,
    raw_json TEXT
  );

  CREATE TABLE product_variations (
    model_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    name TEXT,
    pecas INTEGER,
    price REAL,
    stock INTEGER
  );
  CREATE INDEX idx_variations_item ON product_variations(item_id);

  ALTER TABLE order_items ADD COLUMN item_id TEXT;
  ALTER TABLE order_items ADD COLUMN model_id TEXT;
  UPDATE order_items SET item_id = item_sku WHERE item_sku GLOB '[0-9]*';
  CREATE INDEX idx_order_items_item ON order_items(item_id);
  `,
  // 14 — insumos, suas cores e o que se compra deles.
  //      A cor é variante do mesmo insumo, não insumo separado: a receita pede
  //      "26cm de fita nº9" sem dizer a cor (quem decide é o tema), mas o
  //      estoque e o preço pago são de cada cor.
  `
  CREATE TABLE supplies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- Unidade em que se compra e se consome: folha, ml, cm, m, un.
    unit TEXT NOT NULL,
    -- Abaixo disso o insumo aparece como acabando. NULL = sem alerta.
    min_stock REAL,
    notes TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE supply_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supply_id INTEGER NOT NULL REFERENCES supplies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE(supply_id, name)
  );

  CREATE TABLE purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_id INTEGER NOT NULL REFERENCES supply_variants(id) ON DELETE CASCADE,
    quantity REAL NOT NULL,
    total REAL NOT NULL,
    -- Frete entra no custo: 1000 folhas por 300 + 20 de frete custam 0,32 cada.
    shipping REAL NOT NULL DEFAULT 0,
    bought_at INTEGER NOT NULL,
    supplier TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL
  );

  -- Estoque é o saldo dos movimentos, não um número guardado: assim dá para
  -- responder "por que tenho isso" e refazer a conta quando algo muda.
  CREATE TABLE stock_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_id INTEGER NOT NULL REFERENCES supply_variants(id) ON DELETE CASCADE,
    -- Positivo entra, negativo sai.
    quantity REAL NOT NULL,
    reason TEXT NOT NULL,
    -- Chave de idempotência ('pedido:<order_sn>:<variant_id>'): a baixa
    -- automática roda a cada sincronização e não pode descontar duas vezes.
    ref TEXT UNIQUE,
    order_sn TEXT,
    purchase_id INTEGER,
    happened_at INTEGER NOT NULL,
    notes TEXT
  );
  CREATE INDEX idx_moves_variant ON stock_moves(variant_id);
  `,
  // 15 — o que se fabrica, e com o quê.
  //      Uma receita pode pedir outra receita (laço dentro da caixa milk), e o
  //      conjunto de receitas de caixa forma uma linha de fabricação. O produto
  //      aponta para a linha, que é como "estas caixas se fazem assim".
  `
  CREATE TABLE production_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- NULL = componente reutilizável (o laço), que serve a qualquer linha.
    line_id INTEGER REFERENCES production_lines(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- CAIXA (um dos modelos do kit) · COMPONENTE · EMBALAGEM (uma por pedido).
    kind TEXT NOT NULL,
    -- Quanto uma execução rende. Um laço rende 1; uma fôrma poderia render 4.
    yields REAL NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE recipe_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    supply_id INTEGER REFERENCES supplies(id) ON DELETE CASCADE,
    child_recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
    -- NULL é "um pouco": cola e tinta entram na lista do que é preciso ter,
    -- mas não têm quantidade certa, então não custam nem baixam estoque.
    quantity REAL,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_recipe_items_recipe ON recipe_items(recipe_id);
  `,

  // 16 — listagem principal filtra por aba e ordena pelos pedidos recentes.
  `
  CREATE INDEX idx_orders_tab_created
    ON orders(tab, created_at_shopee DESC, order_sn DESC);
  `
]

export const MIGRATION_COUNT = migrations.length

function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    const next = sql[i + 1]
    if (lineComment) {
      current += char
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      current += char
      if (char === '*' && next === '/') {
        current += next
        i++
        blockComment = false
      }
      continue
    }
    if (!quote && char === '-' && next === '-') {
      current += char + next
      i++
      lineComment = true
      continue
    }
    if (!quote && char === '/' && next === '*') {
      current += char + next
      i++
      blockComment = true
      continue
    }
    if (quote) {
      current += char
      if (char === quote) {
        if (next === quote) {
          current += next
          i++
        } else quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

export function migrationStatements(index: number): string[] {
  return splitStatements(migrations[index])
}

export function runMigrations(db: Database.Database): void {
  db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)').run()
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as {
    version: number
  }
  const currentVersion = Number(row.version)
  for (let i = currentVersion; i < migrations.length; i++) {
    // O executor Hrana cria sua própria transação quando exec() recebe vários
    // comandos e rejeita a transação interna do driver. Enviar um por vez evita
    // o BEGIN aninhado; a versão só avança depois que todos terminarem.
    const statements = migrationStatements(i)
    for (const statement of statements) db.prepare(statement).run()
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(i + 1)
  }
}
