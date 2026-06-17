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
    res.status(405).json({ erro: 'Método não permitido' });
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
    logger.warn('bling-webhook', 'Chave secreta inválida na requisição');
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  const parsed = BlingWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('bling-webhook', 'Rejected: invalid payload', {
      issues: parsed.error.issues,
    });
    res.status(200).json({ sucesso: false, erro: 'Esquema de payload inválido' });
    return;
  }

  const payload = parsed.data;
  const pedido = payload.data;
  const situacaoId = pedido.situacao?.id;

  // Only enqueue dispatch-eligible status changes.
  if (!situacaoId || !DISPATCH_STATUSES.has(situacaoId)) {
    logger.info('bling-webhook', 'Ignorando pedido pois a situação não aciona expedição', { situacaoId });
    res.status(200).json({ sucesso: true, acao: 'ignorado', situacao_id: situacaoId });
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

    logger.info('bling-webhook', 'Evento enfileirado com sucesso', { event_id: result.id });

    res.status(200).json({ sucesso: true, enfileirado: result.enqueued });
  } catch (err) {
    logger.error('bling-webhook', 'Falha no webhook', { error: String(err) });
    res.status(200).json({ sucesso: false, erro: 'Erro interno' });
  }
}
