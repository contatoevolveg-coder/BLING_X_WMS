import type { VercelRequest, VercelResponse } from '@vercel/node';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { enqueue } from '../../../lib/services/queue';
import { logger } from '../../../lib/logger';

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
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // [token] path segment is the WMS_WEBHOOK_TOKEN.
  const token = Array.isArray(req.query['token'])
    ? req.query['token'][0]
    : req.query['token'];

  if (!token || !isValidToken(token)) {
    logger.warn('wms-webhook', 'Rejected: invalid token', {
      ip: req.headers['x-forwarded-for'],
    });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const parsed = WMSPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('wms-webhook', 'Rejected: invalid payload', {
      issues: parsed.error.issues,
    });
    // Return 200 so WMS does not retry on validation failures.
    res.status(200).json({ ok: false, error: 'Invalid payload schema' });
    return;
  }

  const payload = parsed.data;

  // Only EXPEDICAO / FINALIZADO triggers a baixa.
  if (
    payload.classificacao !== 'EXPEDICAO' ||
    payload.tipoEvento !== 'FINALIZADO'
  ) {
    res.status(200).json({ ok: true, action: 'ignored', reason: 'not a finalizado expedicao' });
    return;
  }

  try {
    const result = await enqueue(
      'wms',
      `${payload.classificacao}:${payload.tipoEvento}`,
      payload.metadata.codigoInterno,
      payload
    );

    logger.info('wms-webhook', result.enqueued ? 'Enqueued' : 'Duplicate — skipped', {
      event_id: payload.id,
      idempotency_key: payload.metadata.codigoInterno,
      product_count: payload.metadata.produtos.length,
      duration_ms: Date.now() - start,
    });

    res.status(200).json({ ok: true, enqueued: result.enqueued });
  } catch (err) {
    logger.error('wms-webhook', 'Enqueue error', {
      error: String(err),
      event_id: payload.id,
      duration_ms: Date.now() - start,
    });
    // Always 200 to prevent WMS retry storms.
    res.status(200).json({ ok: false, error: 'Internal error' });
  }
}
