-- ============================================================
-- SyncStock schema — Supabase / PostgreSQL 15
-- Apply via: Supabase Dashboard → SQL Editor, or supabase db push
-- ============================================================

-- ── webhook_events ──────────────────────────────────────────
-- Async job queue replacing Redis / BullMQ.
-- UNIQUE (source, idempotency_key) enforces idempotency at DB level.
CREATE TABLE webhook_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source           TEXT        NOT NULL CHECK (source IN ('wms', 'bling')),
  event_type       TEXT        NOT NULL,
  idempotency_key  TEXT        NOT NULL,
  payload          JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','processing','done','failed','dlq','quarantine')),
  retry_count      INTEGER     NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at     TIMESTAMPTZ,
  CONSTRAINT uq_idempotency UNIQUE (source, idempotency_key)
);

CREATE INDEX idx_webhook_events_status    ON webhook_events (status, created_at);
CREATE INDEX idx_webhook_events_source    ON webhook_events (source, status);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
-- No public policies — only service_role (which bypasses RLS) may access this table.

-- ── product_mappings ────────────────────────────────────────
CREATE TABLE product_mappings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wms_code          TEXT        NOT NULL UNIQUE,
  bling_sku         TEXT        NOT NULL,
  bling_product_id  BIGINT      NOT NULL,
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_product_mappings_wms_code      ON product_mappings (wms_code);
CREATE INDEX idx_product_mappings_bling_sku     ON product_mappings (bling_sku);
CREATE INDEX idx_product_mappings_bling_prod_id ON product_mappings (bling_product_id);

ALTER TABLE product_mappings ENABLE ROW LEVEL SECURITY;

-- ── bling_tokens ────────────────────────────────────────────
-- Singleton row for the app's OAuth 2.0 tokens.
-- singleton_key is always 'default'; PRIMARY KEY enforces one-row constraint.
CREATE TABLE bling_tokens (
  singleton_key  TEXT        PRIMARY KEY DEFAULT 'default',
  access_token   TEXT        NOT NULL,
  refresh_token  TEXT        NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  scope          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bling_tokens ENABLE ROW LEVEL SECURITY;

-- ── stock_snapshots ─────────────────────────────────────────
-- Append-only reconciliation log. No UNIQUE constraint so
-- every reconcile run creates a new snapshot row.
CREATE TABLE stock_snapshots (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT        NOT NULL CHECK (source IN ('wms', 'bling')),
  product_code TEXT        NOT NULL,
  quantity     NUMERIC(14,4) NOT NULL,
  snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stock_snapshots_product ON stock_snapshots (product_code, source, snapshot_at DESC);

ALTER TABLE stock_snapshots ENABLE ROW LEVEL SECURITY;

-- ── claim_pending_events ────────────────────────────────────
-- SELECT FOR UPDATE SKIP LOCKED → atomic batch claim.
-- Called by the process-queue cron to avoid double-processing.
CREATE OR REPLACE FUNCTION claim_pending_events(batch_limit INTEGER DEFAULT 10)
RETURNS SETOF webhook_events
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH claimed AS (
    SELECT id
    FROM   webhook_events
    WHERE  status IN ('pending', 'failed')
      AND  retry_count < 3
    ORDER  BY created_at ASC
    LIMIT  batch_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE webhook_events we
  SET    status = 'processing'
  FROM   claimed
  WHERE  we.id = claimed.id
  RETURNING we.*;
$$;
