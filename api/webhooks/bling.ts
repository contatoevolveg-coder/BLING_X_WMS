import type { VercelRequest, VercelResponse } from '@vercel/node';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { logger } from '../../lib/logger';

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

  // WMS é somente leitura — não criamos expedições no WMS a partir de pedidos Bling.
  // Apenas acusamos recebimento para o Bling não retentar entrega.
  logger.info('bling-webhook', 'Evento recebido e acusado (WMS é leitura — sem enfileiramento)', {
    pedido_id: pedido.id,
    situacao_id: pedido.situacao?.id,
    event: payload.event,
  });
  res.status(200).json({ sucesso: true, acao: 'acknowledged' });
}
