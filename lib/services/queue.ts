import { getSupabase } from '../supabase';
import { logger } from '../logger';
import { sendAlert } from '../alerts';
import type { WebhookEvent, WebhookSource } from '../types';

const MAX_RETRIES = 3;

// Thrown by markQuarantine so the cron loop knows NOT to call markDone
export class QuarantineError extends Error {
  constructor(reason: string) { super(reason); this.name = 'QuarantineError'; }
}

export interface EnqueueResult {
  enqueued: boolean;
  id: string | null;
}

/**
 * Inserts a new webhook_event row with status='pending'.
 * Returns { enqueued: false } on duplicate (unique constraint violation),
 * so the caller can treat it as an idempotent no-op.
 */
export async function enqueue(
  source: WebhookSource,
  eventType: string,
  idempotencyKey: string,
  payload: unknown
): Promise<EnqueueResult> {
  const db = getSupabase();

  const { data, error } = await db
    .from('webhook_events')
    .insert({
      source,
      event_type: eventType,
      idempotency_key: idempotencyKey,
      payload,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) {
    // PostgreSQL unique_violation = 23505
    if (error.code === '23505') {
      return { enqueued: false, id: null };
    }
    throw new Error(`Failed to enqueue event: ${error.message}`);
  }

  return { enqueued: true, id: data.id as string };
}

/**
 * Atomically claims up to `limit` pending/failed events using
 * SELECT FOR UPDATE SKIP LOCKED (via the claim_pending_events RPC).
 * Updates their status to 'processing' in the same transaction.
 */
export async function claimBatch(limit = 10): Promise<WebhookEvent[]> {
  const db = getSupabase();

  const { data, error } = await db.rpc('claim_pending_events', {
    batch_limit: limit,
  });

  if (error) throw new Error(`Failed to claim events: ${error.message}`);
  return (data as WebhookEvent[]) ?? [];
}

export async function markDone(id: string): Promise<void> {
  const db = getSupabase();
  const { error } = await db
    .from('webhook_events')
    .update({ status: 'done', processed_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`markDone failed: ${error.message}`);
}

/**
 * Increments retry_count. Transitions to 'dlq' after MAX_RETRIES
 * or back to 'failed' (which claimBatch will pick up next run).
 */
export async function markFailed(
  id: string,
  currentRetryCount: number,
  errorMessage: string
): Promise<void> {
  const db = getSupabase();
  const newRetryCount = currentRetryCount + 1;
  const newStatus = newRetryCount >= MAX_RETRIES ? 'dlq' : 'failed';

  // Backoff exponencial manual (minutos)
  let backoffMinutes = 1;
  if (newRetryCount === 2) backoffMinutes = 5;
  if (newRetryCount === 3) backoffMinutes = 15;
  
  const nextRetryAt = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();

  const { error } = await db
    .from('webhook_events')
    .update({
      status: newStatus,
      retry_count: newRetryCount,
      next_retry_at: nextRetryAt,
      error: errorMessage.slice(0, 2000), // guard against oversized error strings
    })
    .eq('id', id);

  if (error) throw new Error(`markFailed failed: ${error.message}`);

  logger.warn('queue', `Event ${id} → ${newStatus}`, {
    retry: `${newRetryCount}/${MAX_RETRIES}`,
    error: errorMessage.slice(0, 200),
  });
}

/**
 * Permanently quarantines an event (e.g. unmapped product code).
 * Does not increment retry_count — the event will not be retried.
 */
export async function markQuarantine(
  id: string,
  reason: string
): Promise<never> {
  const db = getSupabase();
  const { error } = await db
    .from('webhook_events')
    .update({
      status: 'quarantine',
      error: reason.slice(0, 2000),
      processed_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) throw new Error(`markQuarantine failed: ${error.message}`);
  logger.warn('queue', `Event ${id} quarantined`, { reason });
  
  // Alerta proativo no Discord/Slack
  await sendAlert(
    '🛑 Pedido na Quarentena (Auto-Map Falhou)',
    `O evento **${id}** foi parado e precisa de intervenção manual.\n\n**Motivo:** ${reason}`,
    'warn'
  ).catch(err => logger.error('queue', 'Falha ao enviar alerta de quarentena', { erro: String(err) }));

  throw new QuarantineError(reason);
}
