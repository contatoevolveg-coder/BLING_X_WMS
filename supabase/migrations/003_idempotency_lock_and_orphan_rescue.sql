-- ============================================================
-- Migration 003: Lock de idempotência em processed_baixas +
--                resgate de eventos órfãos em claim_pending_events
-- ============================================================
-- Contexto: lib/services/stock.ts agora adquire um lock em
-- processed_baixas (status='processing') ANTES de chamar o Bling,
-- e só confirma (status='done') depois da resposta com sucesso.
-- Isso fecha a janela de baixa duplicada que existia quando o
-- registro só era gravado DEPOIS da chamada ao Bling.
--
-- Também adiciona claimed_at a webhook_events e resgate de eventos
-- presos em 'processing' (ex.: função serverless morta por timeout
-- no meio do processamento) — sem isso esses eventos nunca mais
-- seriam reclamados por claim_pending_events.

-- ── processed_baixas: coluna de estado + colunas de auditoria ──
ALTER TABLE processed_baixas
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processing',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill: qualquer linha criada antes desta migration já representa
-- uma baixa historicamente confirmada — nunca deve ser tratada como lock.
UPDATE processed_baixas
SET    status = 'done'
WHERE  status = 'processing'
  AND  created_at < NOW() - INTERVAL '1 minute';

ALTER TABLE processed_baixas
  DROP CONSTRAINT IF EXISTS chk_processed_baixas_status;
ALTER TABLE processed_baixas
  ADD CONSTRAINT chk_processed_baixas_status
  CHECK (status IN ('processing', 'done'));

-- ── webhook_events: claimed_at para lease de eventos travados ──
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- ── claim_pending_events: resgate de órfãos + hardening de segurança ──
-- (retry_count < 3 alinhado com MAX_RETRIES em lib/services/queue.ts —
-- sem depender de uma chave de system_settings que este app não usa)
CREATE OR REPLACE FUNCTION claim_pending_events(batch_limit INTEGER DEFAULT 10)
RETURNS SETOF webhook_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id
    FROM   webhook_events
    WHERE  (
             (status IN ('pending', 'failed')
              AND next_retry_at <= NOW())
             OR
             -- Resgate de órfãos: função morreu (timeout/crash) com o evento
             -- travado em 'processing' há mais de 5 minutos.
             (status = 'processing'
              AND claimed_at < NOW() - INTERVAL '5 minutes')
           )
      AND  retry_count < 3
    ORDER  BY next_retry_at ASC, created_at ASC
    LIMIT  batch_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE webhook_events we
  SET    status     = 'processing',
         claimed_at = NOW()
  FROM   claimed
  WHERE  we.id = claimed.id
  RETURNING we.*;
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_pending_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_pending_events(integer) TO service_role;

CREATE INDEX IF NOT EXISTS idx_webhook_events_claim
ON webhook_events (next_retry_at, created_at)
WHERE status IN ('pending', 'failed');
