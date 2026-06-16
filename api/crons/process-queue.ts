import type { VercelRequest, VercelResponse } from '@vercel/node';
import { claimBatch, markDone, markFailed } from '../../lib/services/queue';
import { processBaixa, processExpedition } from '../../lib/services/stock';
import { logger } from '../../lib/logger';
import type { WebhookEvent } from '../../lib/types';

/**
 * Runs every minute (see vercel.json).
 * Claims up to 10 pending events and routes each to the correct handler.
 *
 * Vercel automatically injects `Authorization: Bearer ${CRON_SECRET}`
 * when invoking this endpoint on a schedule. The check below blocks
 * any external caller that does not know the secret.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const runStart = Date.now();

  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let processed = 0;
  let failed = 0;

  try {
    const events = await claimBatch(10);

    logger.info('process-queue', `Claimed ${events.length} event(s)`);

    for (const event of events) {
      const eventStart = Date.now();
      try {
        await route(event);
        await markDone(event.id);
        processed++;
        logger.info('process-queue', 'Event done', {
          event_id: event.id,
          source: event.source,
          event_type: event.event_type,
          duration_ms: Date.now() - eventStart,
        });
      } catch (err) {
        failed++;
        await markFailed(event.id, event.retry_count, String(err));
        logger.error('process-queue', 'Event failed', {
          event_id: event.id,
          source: event.source,
          error: String(err),
          duration_ms: Date.now() - eventStart,
        });
      }
    }

    res.status(200).json({
      ok: true,
      processed,
      failed,
      duration_ms: Date.now() - runStart,
    });
  } catch (err) {
    logger.error('process-queue', 'Cron run failed', {
      error: String(err),
      duration_ms: Date.now() - runStart,
    });
    res.status(500).json({ ok: false, error: String(err) });
  }
}

async function route(event: WebhookEvent): Promise<void> {
  switch (event.source) {
    case 'wms':
      await processBaixa(event);
      break;
    case 'bling':
      await processExpedition(event);
      break;
    default:
      throw new Error(`Unknown event source: ${event.source}`);
  }
}

function isAuthorized(req: VercelRequest): boolean {
  const cronSecret = process.env['CRON_SECRET'];
  // If CRON_SECRET is not set (local dev without vercel dev), allow through.
  if (!cronSecret) return true;
  return req.headers['authorization'] === `Bearer ${cronSecret}`;
}
