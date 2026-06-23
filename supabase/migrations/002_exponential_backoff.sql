-- ============================================================
-- Migration: Exponential Backoff para a Fila de Webhooks
-- ============================================================

-- Adiciona a coluna que controlará quando será a próxima tentativa
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_webhook_events_next_retry ON webhook_events (next_retry_at);

-- Atualiza a função de resgate da fila para só pegar itens cujo horário de tentativa já chegou
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
      AND  next_retry_at <= NOW()
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
