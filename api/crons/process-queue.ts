import type { VercelRequest, VercelResponse } from '@vercel/node';
import { claimBatch, markDone, markFailed } from '../../lib/services/queue';
import { processBaixa, processExpedition } from '../../lib/services/stock';
import { logger } from '../../lib/logger';
import type { WebhookEvent } from '../../lib/types';

/**
 * CRON DE PROCESSAMENTO DA FILA (Executa a cada minuto, conforme vercel.json).
 * 
 * Arquitetura de Fila:
 * - Em vez de processar os webhooks no momento em que chegam (o que poderia causar timeouts e perdas),
 *   eles são salvos no Supabase com status 'pending'.
 * - Esta função atua como um "Worker" assíncrono. Ela puxa lotes (batches) de 10 eventos pendentes
 *   e processa cada um roteando para o tratador correto (Bling ou WMS).
 * - A paralelização via `Promise.allSettled` permite alta vazão sem bloquear a thread.
 * 
 * Segurança: O Vercel injeta automaticamente `Authorization: Bearer ${CRON_SECRET}` 
 * ao invocar esse endpoint. Bloqueia qualquer tentativa externa sem a chave secreta.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const runStart = Date.now();

  if (!isAuthorized(req)) {
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  let processados = 0;
  let falhas = 0;

  try {
    const events = await claimBatch(10);

    logger.info('process-queue', `Claimed ${events.length} event(s)`);

    await Promise.allSettled(
      events.map(async (event) => {
        const eventStart = Date.now();
        try {
          await route(event);
          await markDone(event.id);
          processados++;
          logger.info('process-queue', 'Evento processado com sucesso', {
            event_id: event.id,
            source: event.source,
            event_type: event.event_type,
            duracao_ms: Date.now() - eventStart,
          });
        } catch (err) {
          falhas++;
          await markFailed(event.id, event.retry_count, String(err));
          logger.error('process-queue', 'Falha no processamento de evento', {
            event_id: event.id,
            source: event.source,
            erro: String(err),
            duracao_ms: Date.now() - eventStart,
          });
        }
      })
    );

    res.status(200).json({
      sucesso: true,
      processados,
      falhas,
      duracao_ms: Date.now() - runStart,
    });
  } catch (err) {
    logger.error('process-queue', 'Falha ao rodar cron', {
      erro: String(err),
      duracao_ms: Date.now() - runStart,
    });
    res.status(500).json({ sucesso: false, erro: String(err) });
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
