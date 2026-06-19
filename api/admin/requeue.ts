import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../../lib/supabase';
import { isDashAuthenticated } from '../../lib/auth';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isDashAuthenticated(req)) {
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ erro: 'Método não permitido' });
    return;
  }

  const body = req.body as { id?: string } | undefined;
  const id = body?.id;

  if (!id) {
    res.status(400).json({ erro: 'Campo id obrigatório' });
    return;
  }

  const db = getSupabase();

  const { data: event, error: fetchErr } = await db
    .from('webhook_events')
    .select('id, status')
    .eq('id', id)
    .single();

  if (fetchErr || !event) {
    res.status(404).json({ erro: 'Evento não encontrado' });
    return;
  }

  if (!['dlq', 'quarantine', 'failed'].includes(event.status)) {
    res.status(400).json({ erro: `Evento está em status "${event.status}", só é possível reprocessar dlq/quarantine/failed` });
    return;
  }

  const { error: updateErr } = await db
    .from('webhook_events')
    .update({ status: 'pending', retry_count: 0, error: null })
    .eq('id', id);

  if (updateErr) {
    res.status(500).json({ erro: updateErr.message });
    return;
  }

  res.status(200).json({ sucesso: true, id });
}
