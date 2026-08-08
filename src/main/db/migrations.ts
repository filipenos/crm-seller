import type { Database } from 'better-sqlite3'

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
  `
]

export function runMigrations(db: Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  for (let i = currentVersion; i < migrations.length; i++) {
    const apply = db.transaction(() => {
      db.exec(migrations[i])
      db.pragma(`user_version = ${i + 1}`)
    })
    apply()
  }
}
