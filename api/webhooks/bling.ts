import type { VercelRequest, VercelResponse } from '@vercel/node';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { enqueue } from '../../lib/services/queue';
import { logger } from '../../lib/logger';

// situacaoId values that should trigger a WMS expedition
const DISPATCH_STATUSES = new Set([9, 15]);

// ── Zod schema ───────────────────────────────────────────────

const BlingItemSchema = z.object({
  id: z.number(),
  produto: z.object({
    id: z.number(),
    nome: z.string().optional(),
    codigo: z.string().optional().default(''),
  }),
  quantidade: z.number().positive(),
});

const BlingPedidoSchema = z.object({
  id: z.number(),
  numero: z.number().optional(),
  situacao: z.object({ id: z.number(), nome: z.string().optional() }).optional(),
  itens: z.array(BlingItemSchema).optional(),
}).passthrough();

const BlingWebhookSchema = z.object({
  data: BlingPedidoSchema,
  event: z.string().optional(),
  retorno: z.string().optional(),
});

// ── Token validation ─────────────────────────────────────────

function isValidBlingToken(provided: string): boolean {
  const expected = process.env['BLING_WEBHOOK_TOKEN'];
  if (!expected || !provided) return false;

  const enc = (s: string) => Buffer.from(s.padEnd(128, '\0'), 'utf8');
  try {
    const a = enc(provided);
    const b = enc(expected);
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

  // Bling sends the webhook token as a query param in the registered URL:
  // https://syncstock.vercel.app/api/webhooks/bling?token=SECRET
  // or as the X-Bling-Token header — we accept both.
  const tokenFromQuery = Array.isArray(req.query['token'])
    ? req.query['token'][0]
    : req.query['token'];
  const tokenFromHeader = req.headers['x-bling-token'] as string | undefined;
  const token = tokenFromHeader ?? tokenFromQuery ?? '';

  if (!isValidBlingToken(token)) {
    logger.warn('bling-webhook', 'Rejected: invalid token', {
      ip: req.headers['x-forwarded-for'],
    });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const parsed = BlingWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('bling-webhook', 'Rejected: invalid payload', {
      issues: parsed.error.issues,
    });
    res.status(200).json({ ok: false, error: 'Invalid payload schema' });
    return;
  }

  const payload = parsed.data;
  const pedido = payload.data;
  const situacaoId = pedido.situacao?.id;

  // Only enqueue dispatch-eligible status changes.
  if (!situacaoId || !DISPATCH_STATUSES.has(situacaoId)) {
    res.status(200).json({ ok: true, action: 'ignored', situacao_id: situacaoId });
    return;
  }

  // Idempotency key is scoped to pedido + situação so a second delivery
  // of the same status change is treated as a duplicate.
  const idempotencyKey = `bling-pedido-${pedido.id}-situacao-${situacaoId}`;

  try {
    const result = await enqueue(
      'bling',
      payload.event ?? 'PedidoVendaAtualizado',
      idempotencyKey,
      pedido
    );

    logger.info('bling-webhook', result.enqueued ? 'Enqueued' : 'Duplicate — skipped', {
      pedido_id: pedido.id,
      situacao_id: situacaoId,
      idempotency_key: idempotencyKey,
      duration_ms: Date.now() - start,
    });

    res.status(200).json({ ok: true, enqueued: result.enqueued });
  } catch (err) {
    logger.error('bling-webhook', 'Enqueue error', {
      error: String(err),
      pedido_id: pedido.id,
      duration_ms: Date.now() - start,
    });
    res.status(200).json({ ok: false, error: 'Internal error' });
  }
}
