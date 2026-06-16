import { getSupabase } from '../supabase';
import type { WebhookSource } from '../types';

/**
 * Returns true if an event with this (source, idempotencyKey) pair
 * already exists in webhook_events in any status.
 */
export async function isAlreadyQueued(
  source: WebhookSource,
  idempotencyKey: string
): Promise<boolean> {
  const db = getSupabase();
  const { data } = await db
    .from('webhook_events')
    .select('id')
    .eq('source', source)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  return data !== null;
}
