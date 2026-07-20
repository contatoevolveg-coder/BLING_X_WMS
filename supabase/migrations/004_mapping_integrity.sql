-- ============================================================
-- Migration 004: Integridade de vínculos + reconciliação de schema
-- ============================================================
-- Contexto: a quebra de estoque teve como causa raiz múltiplas variações WMS
-- (ex.: JS200FAZ00M, JS200FPT00G, ...) vinculadas ao MESMO produto-pai do Bling.
-- A regra de negócio é "1 produto Bling ↔ no máximo 1 código WMS ativo". A guarda
-- é imposta na aplicação (lib/services/mapping-guard.ts); esta migration reconcilia
-- o schema versionado com o banco real e adiciona o índice de dedup de pendências.
--
-- Todos os comandos são idempotentes (IF NOT EXISTS) — no-op onde já aplicado.

-- ── product_catalog (existia só no banco, não nas migrations) ──
CREATE TABLE IF NOT EXISTS product_catalog (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform     TEXT        NOT NULL CHECK (platform IN ('wms','bling')),
  platform_id  TEXT        NOT NULL,
  code         TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  barcode      TEXT,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_catalog_platform_platform_id_key UNIQUE (platform, platform_id)
);
CREATE INDEX IF NOT EXISTS idx_product_catalog_barcode ON product_catalog (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_catalog_code    ON product_catalog (platform, code);

-- ── pending_mappings (existia só no banco, não nas migrations) ──
CREATE TABLE IF NOT EXISTS pending_mappings (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wms_code           TEXT        NOT NULL,
  wms_product_name   TEXT,
  wms_barcode        TEXT,
  bling_sku          TEXT,
  bling_product_id   BIGINT,
  bling_product_name TEXT,
  bling_barcode      TEXT,
  confidence         INTEGER     NOT NULL DEFAULT 0,
  match_method       TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'pending',
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedup real: no máximo UMA sugestão 'pending' por código WMS. Substitui o
-- ON CONFLICT('wms_code,status') que nunca teve índice de suporte e falhava
-- silenciosamente (as sugestões do catalog-sync não eram gravadas).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_wms_pending
  ON pending_mappings (wms_code) WHERE status = 'pending';

-- ── product_mappings: colunas usadas pelo código, ausentes no schema 001 ──
ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS barcode      TEXT;
ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Índice de apoio à guarda 1:1 (busca "este bling_product_id já tem WMS ativo?").
CREATE INDEX IF NOT EXISTS idx_product_mappings_active_bling
  ON product_mappings (bling_product_id) WHERE active;
