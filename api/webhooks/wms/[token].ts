import type { VercelRequest, VercelResponse } from '@vercel/node';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { enqueue, markDone, markFailed, QuarantineError } from '../../../lib/services/queue';
import { processBaixa } from '../../../lib/services/stock';
import { logger } from '../../../lib/logger';
import type { WebhookEvent } from '../../../lib/types';

// Tenta processar a baixa imediatamente (em vez de esperar o próximo cron/cron
// externo). Isso reduz a latência típica de "até 30min" para segundos, e o
// cron continua existindo como rede de segurança para os casos em que o
// processamento inline falha ou a função é encerrada por timeout.
const INLINE_TIMEOUT_MS = 45_000; // maxDuration da Vercel é 60s — deixa margem para markFailed rodar

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: processamento inline não concluiu em ${ms}ms`)), ms)
    ),
  ]);
}

// ── Zod schema ───────────────────────────────────────────────

const ProductSchema = z.object({
  codigoProduto: z.string().min(1),
  quantidade: z.number().positive(),
  lote: z.string().default(''),
});

const MetadataSchema = z.object({
  codigoInterno: z.string().min(1),
  codigoExterno: z.string(),
  quantidadeItens: z.number(),
  produtos: z.array(ProductSchema).min(1),
});

const WMSPayloadSchema = z.object({
  id: z.string().uuid(),
  docEmpresa: z.string(),
  docDepositante: z.string(),
  tipoEvento: z.enum([
    'GERADO',
    'PEDIDO_EM_ATENDIMENTO',
    'FINALIZADO',
    'CANCELADO',
    'ESTORNADO',
  ]),
  dataEvento: z.string(),
  ambiente: z.enum(['PRODUCAO', 'SANDBOX']),
  classificacao: z.enum(['EXPEDICAO', 'RECEBIMENTO']),
  login: z.string(),
  metadata: MetadataSchema,
});

// ── Token validation (constant-time) ────────────────────────

function isValidToken(provided: string): boolean {
  const expected = process.env['WMS_WEBHOOK_TOKEN'];
  if (!expected || !provided) return false;

  // Pad both to the same length so Buffer.byteLength comparison is safe.
  const enc = (s: string) => Buffer.from(s.padEnd(128, '\0'), 'utf8');
  try {
    const a = enc(provided);
    const b = enc(expected);
    // timingSafeEqual requires identical lengths.
    return a.length === b.length && timingSafeEqual(a, b) && provided === expected;
  } catch {
    return false;
  }
}

// ── Handler ──────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const start = Date.now();

  if (req.method !== 'POST') {
    res.status(405).json({ erro: 'Método não permitido' });
    return;
  }

  // [token] path segment is the WMS_WEBHOOK_TOKEN.
  const token = Array.isArray(req.query['token'])
    ? req.query['token'][0]
    : req.query['token'];

  if (!token || !isValidToken(token)) {
    logger.warn('wms-webhook', 'Chave secreta inválida na requisição');
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  const parsed = WMSPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('wms-webhook', 'Rejected: invalid payload', {
      issues: parsed.error.issues,
    });
    // Return 200 so WMS does not retry on validation failures.
    res.status(200).json({ sucesso: false, erro: 'Esquema de payload inválido' });
    return;
  }

  const payload = parsed.data;

  // Only EXPEDICAO / FINALIZADO triggers a baixa.
  if (
    payload.classificacao !== 'EXPEDICAO' ||
    payload.tipoEvento !== 'FINALIZADO'
  ) {
    logger.info('wms-webhook', 'Evento ignorado (não é EXPEDICAO FINALIZADO)', { evento: payload.tipoEvento });
    res.status(200).json({ sucesso: true, acao: 'ignorado', motivo: 'não é expedição finalizada' });
    return;
  }

  try {
    const result = await enqueue(
      'wms',
      `${payload.classificacao}:${payload.tipoEvento}`,
      payload.metadata.codigoInterno,
      payload
    );

    logger.info('wms-webhook', 'Evento enfileirado com sucesso', { event_id: payload.id });

    // Evento duplicado (já recebido antes) — não reprocessa inline, deixa como está.
    if (!result.enqueued || !result.id) {
      res.status(200).json({ sucesso: true, enfileirado: false });
      return;
    }

    // Tenta processar imediatamente. Se falhar/travar, cai para 'failed' e o
    // cron (nativo ou externo) reprocessa depois — igual ao fluxo normal.
    const event: WebhookEvent = {
      id: result.id,
      source: 'wms',
      event_type: `${payload.classificacao}:${payload.tipoEvento}`,
      idempotency_key: payload.metadata.codigoInterno,
      payload,
      status: 'processing',
      retry_count: 0,
      error: null,
      created_at: new Date().toISOString(),
      processed_at: null,
    };

    try {
      await withTimeout(processBaixa(event), INLINE_TIMEOUT_MS);
      await markDone(event.id);
      logger.info('wms-webhook', 'Baixa processada inline com sucesso', { event_id: event.id });
      res.status(200).json({ sucesso: true, enfileirado: true, processado_inline: true });
    } catch (processErr) {
      if (processErr instanceof QuarantineError) {
        // processBaixa já marcou o evento como quarantine — nada a fazer aqui.
        res.status(200).json({ sucesso: true, enfileirado: true, processado_inline: false, motivo: 'quarantine' });
        return;
      }
      logger.warn('wms-webhook', 'Processamento inline falhou — evento cai para retry via cron', {
        event_id: event.id,
        erro: String(processErr),
      });
      await markFailed(event.id, 0, String(processErr));
      res.status(200).json({ sucesso: true, enfileirado: true, processado_inline: false });
    }
  } catch (err) {
    logger.error('wms-webhook', 'Falha no webhook', { error: String(err) });
    // Always 200 to prevent WMS retry storms.
    res.status(200).json({ sucesso: false, erro: 'Erro interno' });
  }
}
