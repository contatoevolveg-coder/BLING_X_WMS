-- ============================================================
-- SyncStock schema migration — 002_settings_and_idempotency
-- ============================================================

-- ── system_settings ─────────────────────────────────────────
-- Stores dynamic configuration keys such as API keys and URLs
-- to allow real-time changes without redeploying.
CREATE TABLE system_settings (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- ── processed_baixas ────────────────────────────────────────
-- Idempotency table for Bling stock deductions.
-- Ensures that if the worker fails partially, retries do not
-- deduct stock again for already processed items.
CREATE TABLE processed_baixas (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wms_code    TEXT        NOT NULL,
  event_id    TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_processed_baixas UNIQUE (wms_code, event_id)
);

CREATE INDEX idx_processed_baixas_event ON processed_baixas (event_id);

ALTER TABLE processed_baixas ENABLE ROW LEVEL SECURITY;
