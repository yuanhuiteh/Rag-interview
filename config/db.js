import mysql from "mysql2/promise";
import { DB_HOST, DB_USER, DB_PASS, DB_NAME } from "./env.js";

let pool;

export async function getPool() {
  if (!pool) {
    // Connect without DB first to create it if missing
    const tempPool = mysql.createPool({ host: DB_HOST, user: DB_USER, password: DB_PASS, waitForConnections: true });
    await tempPool.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await tempPool.end();

    pool = mysql.createPool({
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASS,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      charset: "utf8mb4",
    });
    console.log("[DB] Connected to", DB_NAME);
  }
  return pool;
}

export async function q(sql, params = []) {
  const p = await getPool();
  const [rows] = await p.query(sql, params);
  return rows;
}

export async function columnExists(table, column) {
  const p = await getPool();
  const [rows] = await p.query(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB_NAME, table, column]
  );
  return rows.length > 0;
}

export async function addColumnIfMissing(table, column, ddlFragment) {
  if (!(await columnExists(table, column))) {
    await q(`ALTER TABLE ${table} ADD COLUMN ${ddlFragment}`);
    console.log(`[DB] Added column ${table}.${column}`);
  }
}

export async function indexExists(table, indexName) {
  const p = await getPool();
  const [rows] = await p.query(
    `SELECT INDEX_NAME 
     FROM information_schema.STATISTICS 
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [DB_NAME, table, indexName]
  );
  return rows.length > 0;
}

export async function addIndexIfMissing(table, indexName, ddlFragment) {
  if (!(await indexExists(table, indexName))) {
    await q(`ALTER TABLE ${table} ADD INDEX ${indexName} ${ddlFragment}`);
    console.log(`[DB] Added index ${table}.${indexName}`);
  }
}

export async function ensureSchema() {
  const charset = "DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

  await q(`CREATE TABLE IF NOT EXISTS tenants (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_key VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB ${charset};`);

  await q(`CREATE TABLE IF NOT EXISTS documents (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
    title VARCHAR(255) NOT NULL,
    lang VARCHAR(10) NULL,
    source_url VARCHAR(1024) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB ${charset};`);

  await q(`CREATE TABLE IF NOT EXISTS chunks (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
    doc_id BIGINT UNSIGNED NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FULLTEXT KEY ft_content (content)
  ) ENGINE=InnoDB ${charset};`);

  await q(`CREATE TABLE IF NOT EXISTS conversations (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
    external_id VARCHAR(128) NULL,
    channel VARCHAR(32) NOT NULL DEFAULT 'api',
    user_key VARCHAR(128) NOT NULL,
    lang VARCHAR(10) NULL,
    pricing_stage VARCHAR(32) DEFAULT 'READY',
    cart_json JSON NULL,
    pending_product_id BIGINT UNSIGNED NULL,
    stage VARCHAR(64) DEFAULT 'main_menu',
    menu_stage VARCHAR(128) DEFAULT 'ready',
    collected_data JSON NULL,
    short_memory JSON NULL,
    long_memory TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_external_lookup (tenant_id, external_id),
    KEY idx_tenant_user_channel (tenant_id, user_key, channel, id),
    KEY idx_pending_product_id (pending_product_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB ${charset};`);

  await q(`CREATE TABLE IF NOT EXISTS cannot_solve (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
    conversation_id BIGINT UNSIGNED NULL,
    user_key VARCHAR(128) NOT NULL,
    question TEXT NOT NULL,
    reason_code VARCHAR(64) NOT NULL,
    top_candidates JSON NULL,
    count INT UNSIGNED NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_tenant_id (tenant_id, id),
    KEY idx_conversation_id (conversation_id),
    KEY idx_reason_code (tenant_id, reason_code),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB ${charset};`);

  await q(`CREATE TABLE IF NOT EXISTS products (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    sku VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tenant_sku (tenant_id, sku),
    KEY idx_tenant_active (tenant_id, active),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB ${charset};`);

  await q(`CREATE TABLE IF NOT EXISTS product_variants (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    variant_key VARCHAR(64) NOT NULL,
    variant_name VARCHAR(255) NOT NULL,
    base_price_cents INT UNSIGNED NOT NULL,
    currency CHAR(3) DEFAULT 'MYR',
    active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tenant_product_variant (tenant_id, product_id, variant_key),
    KEY idx_variant_lookup (tenant_id, product_id, active),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB ${charset};`);

  await q(`CREATE TABLE IF NOT EXISTS addons (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    addon_sku VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    price_cents INT UNSIGNED NOT NULL,
    currency CHAR(3) DEFAULT 'MYR',
    active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tenant_addon_sku (tenant_id, addon_sku),
    KEY idx_addon_lookup (tenant_id, active),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB ${charset};`);

  await q(`CREATE TABLE IF NOT EXISTS variant_addons (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    variant_id BIGINT UNSIGNED NOT NULL,
    addon_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_variant_addon (tenant_id, variant_id, addon_id),
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
    FOREIGN KEY (addon_id) REFERENCES addons(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB ${charset};`);

  await q(`
    INSERT INTO tenants (tenant_key, name)
    VALUES ('default','Default Tenant')
    ON DUPLICATE KEY UPDATE name=VALUES(name)
  `);

  await addColumnIfMissing("documents", "tenant_id", "tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1");
  await addColumnIfMissing("chunks", "tenant_id", "tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1");
  await addColumnIfMissing("conversations", "tenant_id", "tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1");
  await addColumnIfMissing("conversations", "external_id", "external_id VARCHAR(128) NULL");
  await addColumnIfMissing("conversations", "channel", "channel VARCHAR(32) NOT NULL DEFAULT 'api'");
  await addColumnIfMissing("conversations", "user_key", "user_key VARCHAR(128) NOT NULL DEFAULT 'unknown'");
  await addColumnIfMissing("conversations", "lang", "lang VARCHAR(10) NULL");
  await addColumnIfMissing("conversations", "pricing_stage", "pricing_stage VARCHAR(32) DEFAULT 'READY'");
  await addColumnIfMissing("conversations", "cart_json", "cart_json JSON NULL");
  await addColumnIfMissing("conversations", "pending_product_id", "pending_product_id BIGINT UNSIGNED NULL");
  await addColumnIfMissing("conversations", "stage", "stage VARCHAR(64) DEFAULT 'main_menu'");
  await addColumnIfMissing("conversations", "menu_stage", "menu_stage VARCHAR(128) DEFAULT 'ready'");
  await addColumnIfMissing("conversations", "collected_data", "collected_data JSON NULL");
  await addColumnIfMissing("conversations", "short_memory", "short_memory JSON NULL");
  await addColumnIfMissing("conversations", "long_memory", "long_memory TEXT NULL");
  await addColumnIfMissing("conversations", "updated_at", "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
  await addIndexIfMissing("conversations", "idx_external_lookup", "(tenant_id, external_id)");
  await addIndexIfMissing("conversations", "idx_tenant_user_channel", "(tenant_id, user_key, channel, id)");
  await addIndexIfMissing("conversations", "idx_pending_product_id", "(pending_product_id)");
  await addColumnIfMissing("cannot_solve", "conversation_id", "conversation_id BIGINT UNSIGNED NULL");
  await addColumnIfMissing("cannot_solve", "user_key", "user_key VARCHAR(128) NOT NULL DEFAULT 'unknown'");
  await addColumnIfMissing("cannot_solve", "question", "question TEXT NULL");
  await addColumnIfMissing("cannot_solve", "reason_code", "reason_code VARCHAR(64) NULL");
  await addColumnIfMissing("cannot_solve", "top_candidates", "top_candidates JSON NULL");
  await addColumnIfMissing("cannot_solve", "count", "count INT UNSIGNED NOT NULL DEFAULT 1");
  await addIndexIfMissing("cannot_solve", "idx_conversation_id", "(conversation_id)");
  await addIndexIfMissing("cannot_solve", "idx_reason_code", "(tenant_id, reason_code)");

  await q(`CREATE TABLE IF NOT EXISTS tenant_main_menus (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    menu_name VARCHAR(128) NOT NULL,
    menu_key VARCHAR(64) NOT NULL,
    workflow_schema TEXT NULL,
    active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_tenant_id (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB ${charset};`);

  await q(`CREATE TABLE IF NOT EXISTS support_tickets (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    conversation_id BIGINT UNSIGNED NOT NULL,
    user_key VARCHAR(128) NOT NULL,
    tenant_main_menu_id BIGINT UNSIGNED NOT NULL,
    collected_data LONGTEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_tenant_id (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_main_menu_id) REFERENCES tenant_main_menus(id) ON DELETE CASCADE
  ) ENGINE=InnoDB ${charset};`);

  console.log("[DB] Schema verified / migrated.");
}

const tenantCache = new Map();

export async function ensureDefaultTenant() {
  const rows = await q(`SELECT * FROM tenants WHERE tenant_key='default' LIMIT 1`);
  if (rows.length) {
    tenantCache.set("default", rows[0]);
    return rows[0];
  }
  await q(`INSERT INTO tenants (tenant_key, name) VALUES ('default','Default Tenant')`);
  const created = await q(`SELECT * FROM tenants WHERE tenant_key='default' LIMIT 1`);
  tenantCache.set("default", created[0]);
  return created[0];
}

export async function getTenantById(id) {
  const cacheKey = `_id:${id}`;
  if (tenantCache.has(cacheKey)) return tenantCache.get(cacheKey);

  const rows = await q(`SELECT * FROM tenants WHERE id=? LIMIT 1`, [id]);
  if (rows.length) {
    tenantCache.set(cacheKey, rows[0]);
    return rows[0];
  }
  return null;
}

export async function getTenantByKey(tenant_key) {
  const key = (tenant_key || "default").trim() || "default";
  if (tenantCache.has(key)) return tenantCache.get(key);

  const rows = await q(`SELECT * FROM tenants WHERE tenant_key=? LIMIT 1`, [key]);
  if (rows.length) {
    tenantCache.set(key, rows[0]);
    return rows[0];
  }
  return await ensureDefaultTenant();
}
