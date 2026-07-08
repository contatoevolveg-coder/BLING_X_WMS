import type { VercelRequest, VercelResponse } from '@vercel/node';
import { claimBatch, markDone, markFailed, QuarantineError } from '../../lib/services/queue';
import { processBaixa } from '../../lib/services/stock';
import { logger } from '../../lib/logger';
import { sendAlert } from '../../lib/alerts';
import type { WebhookEvent } from '../../lib/types';

/**
 * CRON DE PROCESSAMENTO DA FILA.
 *
 * O cron nativo da Vercel (vercel.json) roda 1x/dia — limite do plano Hobby.
 * Para não depender só disso, dois mecanismos cobrem o intervalo:
 * 1. O webhook do WMS agora tenta processar a baixa INLINE assim que chega
 *    (ver api/webhooks/wms/[token].ts) — a maioria dos eventos nunca passa
 *    por este cron.
 * 2. Um serviço externo (cron-job.org, configurável na aba Configurações do
 *    dashboard) chama este endpoint a cada 30min como rede de segurança para
 *    eventos que falharam no processamento inline.
 *
 * Arquitetura de Fila:
 * - Eventos ficam em webhook_events com status 'pending' até serem reclamados.
 * - Esta função atua como um "Worker": puxa um lote de eventos pendentes/com
 *   falha e processa cada um sequencialmente, roteando para o tratador correto.
 *
 * Segurança: O Vercel injeta automaticamente `Authorization: Bearer ${CRON_SECRET}`
 * ao invocar esse endpoint via cron nativo. O cron externo precisa do mesmo header,
 * com o valor lido das env vars da Vercel — NUNCA hardcoded em código ou HTML.
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
    // Batch size 5, sequential — avoid Bling rate limits (429) from parallel API calls
    const events = await claimBatch(5);

    logger.info('process-queue', `Claimed ${events.length} event(s)`);

    for (const event of events) {
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
        // QuarantineError: event was intentionally quarantined — not a failure
        if (err instanceof QuarantineError) {
          processados++;
          continue;
        }
        falhas++;
        const willBeDlq = event.retry_count + 1 >= 3;
        await markFailed(event.id, event.retry_count, String(err));
        logger.error('process-queue', 'Falha no processamento de evento', {
          event_id: event.id,
          source: event.source,
          erro: String(err),
          duracao_ms: Date.now() - eventStart,
        });
        if (willBeDlq) {
          await sendAlert(
            '⚠️ Evento foi para DLQ',
            `**ID:** ${event.id}\n**Origem:** ${event.source}\n**Tipo:** ${event.event_type}\n**Erro:** ${String(err).slice(0, 500)}\n\nAcesse o dashboard para reprocessar.`,
            'error'
          );
        }
      }
    }

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
      // WMS é somente leitura — eventos Bling não geram expedição; apenas acusamos recebimento
      logger.info('process-queue', 'Evento Bling ignorado — WMS é leitura', { event_id: event.id });
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
