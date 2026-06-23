import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../../lib/supabase';
import { isDashAuthenticated } from '../../lib/auth';

const FAILURE_STATUSES = ['failed', 'dlq', 'quarantine'];

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isDashAuthenticated(req)) {
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.status(405).json({ erro: 'Método não permitido' });
    return;
  }

  const db = getSupabase();

  // DELETE ?id=<uuid> — remove single event
  if (req.method === 'DELETE') {
    const id = req.query['id'] as string | undefined;
    if (!id) { res.status(400).json({ erro: 'Query param id obrigatório' }); return; }

    const { error } = await db.from('webhook_events').delete().eq('id', id);
    if (error) { res.status(500).json({ erro: error.message }); return; }
    res.status(200).json({ sucesso: true });
    return;
  }

  // POST actions
  const body = req.body as { action?: string; id?: string; status?: string } | undefined;

  // Resolver — marca como done sem reprocessar (encerrar sem retry)
  if (body?.action === 'resolve') {
    const id = body.id;
    if (!id) { res.status(400).json({ erro: 'Campo id obrigatório' }); return; }

    const { data: ev, error: fetchErr } = await db
      .from('webhook_events').select('id, status').eq('id', id).single();
    if (fetchErr || !ev) { res.status(404).json({ erro: 'Evento não encontrado' }); return; }

    if (!FAILURE_STATUSES.includes(ev.status)) {
      res.status(400).json({ erro: `Status "${ev.status}" não precisa ser resolvido` });
      return;
    }

    const { error } = await db
      .from('webhook_events')
      .update({ status: 'done', processed_at: new Date().toISOString() })
      .eq('id', id);

    if (error) { res.status(500).json({ erro: error.message }); return; }
    res.status(200).json({ sucesso: true });
    return;
  }

  // Excluir único evento por id
  if (body?.action === 'delete') {
    const id = body.id;
    if (!id) { res.status(400).json({ erro: 'Campo id obrigatório' }); return; }

    const { error } = await db.from('webhook_events').delete().eq('id', id);
    if (error) { res.status(500).json({ erro: error.message }); return; }
    res.status(200).json({ sucesso: true });
    return;
  }

  // Limpar em massa por status (dlq, quarantine, failed ou combinação)
  if (body?.action === 'clear') {
    const status = body.status;
    const allowed = ['dlq', 'quarantine', 'failed', 'all-failures'];
    if (!status || !allowed.includes(status)) {
      res.status(400).json({ erro: `status deve ser: ${allowed.join(', ')}` });
      return;
    }

    const targetStatuses = status === 'all-failures' ? FAILURE_STATUSES : [status];
    const { error, count } = await db
      .from('webhook_events')
      .delete({ count: 'exact' })
      .in('status', targetStatuses);

    if (error) { res.status(500).json({ erro: error.message }); return; }
    res.status(200).json({ sucesso: true, removidos: count ?? 0 });
    return;
  }

  res.status(400).json({ erro: 'Ação inválida. Use: resolve, delete, clear' });
}
