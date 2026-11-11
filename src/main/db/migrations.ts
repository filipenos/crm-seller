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
  `,

  // 17 — domínio independente de composição e produção.
  // Não referencia pedidos nem catálogo da Shopee: primeiro validamos o que é
  // fabricado, seus custos e estoque; a integração comercial vem depois.
  `
  CREATE TABLE composition_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('MATERIA_PRIMA', 'COMPONENTE', 'CAIXA', 'KIT')),
    unit TEXT NOT NULL,
    sellable INTEGER NOT NULL DEFAULT 0,
    stock_controlled INTEGER NOT NULL DEFAULT 0,
    reference_cost REAL,
    waste_percent REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE composition_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES composition_items(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE(item_id, name)
  );

  CREATE TABLE composition_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_item_id INTEGER NOT NULL REFERENCES composition_items(id) ON DELETE CASCADE,
    child_item_id INTEGER NOT NULL REFERENCES composition_items(id) ON DELETE RESTRICT,
    -- NULL significa quantidade ainda não medida; aparece como pendência e
    -- não participa do custo até ser preenchida.
    quantity REAL CHECK(quantity IS NULL OR quantity > 0),
    position INTEGER NOT NULL DEFAULT 0,
    CHECK(parent_item_id != child_item_id),
    UNIQUE(parent_item_id, child_item_id)
  );
  CREATE INDEX idx_composition_parts_parent ON composition_parts(parent_item_id);
  CREATE INDEX idx_composition_parts_child ON composition_parts(child_item_id);

  CREATE TABLE composition_kit_sizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kit_item_id INTEGER NOT NULL REFERENCES composition_items(id) ON DELETE CASCADE,
    total_units INTEGER NOT NULL CHECK(total_units > 0),
    multiplier REAL NOT NULL CHECK(multiplier > 0),
    UNIQUE(kit_item_id, total_units)
  );

  CREATE TABLE composition_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_key TEXT NOT NULL UNIQUE,
    item_id INTEGER NOT NULL REFERENCES composition_items(id) ON DELETE RESTRICT,
    variant_id INTEGER REFERENCES composition_variants(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK(quantity > 0),
    total REAL NOT NULL CHECK(total >= 0),
    shipping REAL NOT NULL DEFAULT 0 CHECK(shipping >= 0),
    bought_at INTEGER NOT NULL,
    supplier TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_composition_purchases_item ON composition_purchases(item_id);

  CREATE TABLE composition_production_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_key TEXT NOT NULL UNIQUE,
    item_id INTEGER NOT NULL REFERENCES composition_items(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK(quantity > 0),
    estimated_unit_cost REAL NOT NULL,
    actual_total_cost REAL NOT NULL,
    produced_at INTEGER NOT NULL,
    notes TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE composition_lot_consumptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lot_id INTEGER NOT NULL REFERENCES composition_production_lots(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES composition_items(id) ON DELETE RESTRICT,
    variant_id INTEGER REFERENCES composition_variants(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK(quantity > 0),
    unit_cost REAL NOT NULL,
    total_cost REAL NOT NULL
  );

  CREATE TABLE composition_stock_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES composition_items(id) ON DELETE RESTRICT,
    variant_id INTEGER REFERENCES composition_variants(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL,
    unit_cost REAL,
    reason TEXT NOT NULL CHECK(reason IN ('COMPRA', 'PRODUCAO_ENTRADA', 'PRODUCAO_CONSUMO', 'AJUSTE')),
    purchase_id INTEGER REFERENCES composition_purchases(id) ON DELETE SET NULL,
    lot_id INTEGER REFERENCES composition_production_lots(id) ON DELETE SET NULL,
    happened_at INTEGER NOT NULL,
    notes TEXT
  );
  CREATE INDEX idx_composition_stock_item ON composition_stock_moves(item_id, variant_id);
  `,

  // 18 — identifica no lote o tema/versão e o tamanho comercial do kit.
  `
  ALTER TABLE composition_production_lots
    ADD COLUMN variant_id INTEGER REFERENCES composition_variants(id) ON DELETE RESTRICT;
  ALTER TABLE composition_production_lots
    ADD COLUMN kit_size_id INTEGER REFERENCES composition_kit_sizes(id) ON DELETE RESTRICT;
  UPDATE composition_items SET stock_controlled = 1 WHERE slug = 'kit-caixas';
  `,

  // 19 — cola e tinta são estimadas por aplicação enquanto não há medição física.
  `
  UPDATE composition_items
    SET unit = 'aplicação', reference_cost = 0.05, stock_controlled = 1, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE slug = 'cola';
  UPDATE composition_items
    SET unit = 'aplicação', reference_cost = 0.05, stock_controlled = 0, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE slug = 'tinta';
  UPDATE composition_parts
    SET quantity = 1
    WHERE child_item_id IN (SELECT id FROM composition_items WHERE slug IN ('cola', 'tinta'));
  `,
  // 20 — parcelas do frete. O total pago pelo comprador pode incluir frete,
  //      mas a Shopee também registra o custo logístico e o subsídio dela.
  `
  ALTER TABLE order_income ADD COLUMN frete_pago_comprador REAL;
  ALTER TABLE order_income ADD COLUMN custo_frete REAL;
  ALTER TABLE order_income ADD COLUMN subsidio_frete_shopee REAL;
  `,
  // 21 — snapshots de desempenho. Uma sincronização reúne os dados na Shopee
  // e grava tudo em um único batch, porque o Turso é remoto.
  `
  CREATE TABLE performance_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL,
    synced_at INTEGER NOT NULL,
    impressions REAL NOT NULL DEFAULT 0,
    clicks REAL NOT NULL DEFAULT 0,
    orders_count REAL NOT NULL DEFAULT 0,
    units REAL NOT NULL DEFAULT 0,
    sales REAL NOT NULL DEFAULT 0,
    ads_impressions REAL NOT NULL DEFAULT 0,
    ads_clicks REAL NOT NULL DEFAULT 0,
    ads_orders REAL NOT NULL DEFAULT 0,
    ads_sales REAL NOT NULL DEFAULT 0,
    ads_cost REAL NOT NULL DEFAULT 0,
    flash_viewers REAL NOT NULL DEFAULT 0,
    flash_impressions REAL NOT NULL DEFAULT 0,
    flash_clicks REAL NOT NULL DEFAULT 0,
    flash_orders REAL NOT NULL DEFAULT 0,
    flash_units REAL NOT NULL DEFAULT 0,
    flash_sales REAL NOT NULL DEFAULT 0,
    UNIQUE(period_start, period_end)
  );

  CREATE TABLE product_performance (
    snapshot_id INTEGER NOT NULL REFERENCES performance_snapshots(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    name TEXT NOT NULL,
    image_url TEXT,
    impressions REAL NOT NULL DEFAULT 0,
    clicks REAL NOT NULL DEFAULT 0,
    visitors REAL NOT NULL DEFAULT 0,
    likes REAL NOT NULL DEFAULT 0,
    add_to_cart_buyers REAL NOT NULL DEFAULT 0,
    orders_count REAL NOT NULL DEFAULT 0,
    units REAL NOT NULL DEFAULT 0,
    sales REAL NOT NULL DEFAULT 0,
    PRIMARY KEY(snapshot_id, item_id)
  );
  CREATE INDEX idx_product_performance_item ON product_performance(item_id);

  CREATE TABLE flash_sale_performance (
    snapshot_id INTEGER NOT NULL REFERENCES performance_snapshots(id) ON DELETE CASCADE,
    flash_sale_id TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    status INTEGER,
    item_count INTEGER NOT NULL DEFAULT 0,
    enabled_item_count INTEGER NOT NULL DEFAULT 0,
    clicks REAL NOT NULL DEFAULT 0,
    PRIMARY KEY(snapshot_id, flash_sale_id)
  );
  `,
  // 22 — série diária de desempenho. Intervalos escolhidos na interface são
  // somados no Turso, sem uma nova chamada à Shopee a cada troca de datas.
  `
  CREATE TABLE daily_performance (
    day INTEGER PRIMARY KEY,
    synced_at INTEGER NOT NULL,
    shop_views REAL NOT NULL DEFAULT 0,
    shop_visitors REAL NOT NULL DEFAULT 0,
    product_clicks REAL NOT NULL DEFAULT 0,
    orders_count REAL NOT NULL DEFAULT 0,
    sales REAL NOT NULL DEFAULT 0,
    ads_impressions REAL NOT NULL DEFAULT 0,
    ads_clicks REAL NOT NULL DEFAULT 0,
    ads_orders REAL NOT NULL DEFAULT 0,
    ads_sales REAL NOT NULL DEFAULT 0,
    ads_cost REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_daily_performance_synced ON daily_performance(synced_at);
  `,
  // 23 — produtos que não são caixas. A quantidade de laços vem da segunda
  //      parte da variação "Cor,Quantidade"; os pedidos antigos são corrigidos
  //      em uma consulta, sem reler a Shopee.
  `
  ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'CAIXAS';
  ALTER TABLE order_items ADD COLUMN lacos INTEGER;

  UPDATE products SET kind = 'LACOS'
   WHERE lower(trim(name)) LIKE 'kit laço%'
      OR lower(trim(name)) LIKE 'kit laco%'
      OR lower(trim(name)) LIKE 'kit de laço%'
      OR lower(trim(name)) LIKE 'kit de laco%';

  UPDATE order_items SET lacos = CAST(trim(substr(model_name, instr(model_name, ',') + 1)) AS INTEGER)
   WHERE item_id IN (SELECT item_id FROM products WHERE kind = 'LACOS')
     AND instr(model_name, ',') > 0
     AND CAST(trim(substr(model_name, instr(model_name, ',') + 1)) AS INTEGER) IN (10, 20, 30, 40);
  `,
  // 24 — previsão de entrega separada do prazo de postagem e da liberação do pagamento.
  `
  ALTER TABLE orders ADD COLUMN expected_delivery_at INTEGER;
  `,
  // 25 — horário em que a logística foi criada após a geração da etiqueta.
  `
  ALTER TABLE orders ADD COLUMN label_generated_at INTEGER;
  UPDATE orders SET label_generated_at = (
    SELECT MIN(e.happened_at) FROM order_events e
     WHERE e.order_sn = orders.order_sn AND e.source = 'logistics'
       AND LOWER(TRIM(e.description)) = 'pedido em preparação'
  ) WHERE EXISTS (
    SELECT 1 FROM order_events e WHERE e.order_sn = orders.order_sn
      AND e.source = 'logistics' AND LOWER(TRIM(e.description)) = 'pedido em preparação'
  );
  `,
  // 26 — restaura o horário real do extrato, que sincronizações posteriores
  // sobrescreviam com a data aproximada derivada do número do pedido.
  `
  WITH exact AS (
    SELECT i.order_sn,
      MIN(CASE WHEN CAST(json_extract(t.value, '$.ctime') AS INTEGER) < 10000000000
        THEN CAST(json_extract(t.value, '$.ctime') AS INTEGER) * 1000
        ELSE CAST(json_extract(t.value, '$.ctime') AS INTEGER) END) AS created_at
    FROM order_income i, json_each(i.raw_json, '$.tracking_info_list') t
    WHERE i.raw_json IS NOT NULL
      AND json_type(t.value, '$.ctime') IN ('integer', 'real')
      AND CAST(json_extract(t.value, '$.ctime') AS INTEGER) > 0
    GROUP BY i.order_sn
  )
  UPDATE orders SET created_at_shopee = (
    SELECT created_at FROM exact WHERE exact.order_sn = orders.order_sn
  ) WHERE order_sn IN (SELECT order_sn FROM exact)
    AND created_at_shopee IS NOT (
      SELECT created_at FROM exact WHERE exact.order_sn = orders.order_sn
    );
  `,
  // 27 — evita repetir consultas históricas de rastreio na Shopee.
  `
  CREATE TABLE report_tracking_audit (
    order_sn TEXT PRIMARY KEY REFERENCES orders(order_sn) ON DELETE CASCADE,
    checked_at INTEGER NOT NULL
  );
  `,
  // 28 — o controle de rastreio pertence à sincronização, não ao relatório.
  `
  ALTER TABLE report_tracking_audit RENAME TO tracking_audit;
  `,
  // 29 — vínculo do anúncio com a pasta local do tema.
  `
  ALTER TABLE products ADD COLUMN template_key TEXT;
  `,
  // 30 — produção por item, com fluxos separados de caixas e laços.
  `
  UPDATE orders SET stage_id = NULL;
  DELETE FROM stage_actions;
  DELETE FROM workflow_stages;

  CREATE TABLE production_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    product_kind TEXT NOT NULL UNIQUE
  );
  CREATE TABLE production_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_id INTEGER NOT NULL REFERENCES production_flows(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    color TEXT,
    UNIQUE(flow_id, code)
  );
  CREATE INDEX idx_production_stages_flow ON production_stages(flow_id, position);
  CREATE TABLE production_stage_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_id INTEGER NOT NULL REFERENCES production_stages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    position INTEGER NOT NULL,
    UNIQUE(stage_id, kind)
  );
  CREATE TABLE order_item_work (
    order_sn TEXT NOT NULL REFERENCES orders(order_sn) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    stage_id INTEGER NOT NULL REFERENCES production_stages(id),
    art_generated_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(order_sn, item_id, model_id)
  );
  CREATE TABLE order_item_work_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_sn TEXT NOT NULL,
    item_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    happened_at INTEGER NOT NULL
  );
  CREATE INDEX idx_order_item_work_events_order ON order_item_work_events(order_sn, happened_at);

  INSERT INTO production_flows (id, code, name, product_kind) VALUES
    (1, 'boxes', 'Kit de caixas', 'CAIXAS'),
    (2, 'bows', 'Kit de laços', 'LACOS');
  INSERT INTO production_stages (id, flow_id, code, name, position, color) VALUES
    (1, 1, 'WAITING_DATA', 'Aguardando dados', 1, '#f59e0b'),
    (2, 1, 'DATA_RECEIVED', 'Dados recebidos', 2, '#3b82f6'),
    (3, 1, 'ART_REVIEW', 'Arte em revisão', 3, '#8b5cf6'),
    (4, 1, 'ART_APPROVED', 'Arte aprovada', 4, '#0ea5e9'),
    (5, 1, 'PRINTING', 'Imprimindo', 5, '#06b6d4'),
    (6, 1, 'PRINTED', 'Impresso', 6, '#14b8a6'),
    (7, 1, 'CUT', 'Cortado', 7, '#22c55e'),
    (8, 1, 'FOLDED', 'Dobrado', 8, '#65a30d'),
    (9, 1, 'GLUED', 'Colado', 9, '#84cc16'),
    (10, 1, 'PACKED', 'Embalado', 10, '#16a34a'),
    (11, 2, 'TO_PRODUCE', 'A produzir', 1, '#f59e0b'),
    (12, 2, 'PRODUCING', 'Produzindo', 2, '#3b82f6'),
    (13, 2, 'READY', 'Pronto', 3, '#14b8a6'),
    (14, 2, 'PACKED', 'Embalado', 4, '#16a34a');
  INSERT INTO production_stage_actions (stage_id, kind, label, position) VALUES
    (1, 'RECEIVE_DATA', 'Dados recebidos', 1),
    (2, 'GENERATE_ART', 'Gerar arte', 1),
    (3, 'EDIT_ART', 'Editar arte', 1),
    (3, 'APPROVE_ART', 'Aprovar arte', 2),
    (4, 'PRINT_ART', 'Abrir para imprimir', 1),
    (5, 'RETRY_PRINT', 'Abrir PDF novamente', 1),
    (5, 'CONFIRM_PRINT', 'Impressão concluída', 2),
    (6, 'ADVANCE', 'Marcar cortado', 1),
    (7, 'ADVANCE', 'Marcar dobrado', 1),
    (8, 'ADVANCE', 'Marcar colado', 1),
    (9, 'ADVANCE', 'Marcar embalado', 1),
    (11, 'ADVANCE', 'Iniciar produção', 1),
    (12, 'ADVANCE', 'Marcar pronto', 1),
    (13, 'ADVANCE', 'Marcar embalado', 1);
  `,
  // 31 — pedidos escolhidos para o trabalho atual, independente do prazo.
  `
  CREATE TABLE current_work_orders (
    order_sn TEXT PRIMARY KEY REFERENCES orders(order_sn) ON DELETE CASCADE,
    selected_at INTEGER NOT NULL
  );
  CREATE INDEX idx_current_work_selected ON current_work_orders(selected_at);
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
