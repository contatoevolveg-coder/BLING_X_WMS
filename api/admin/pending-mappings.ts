import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../../lib/supabase';
import { isDashAuthenticated } from '../../lib/auth';
import { findConflictingWmsCode } from '../../lib/services/mapping-guard';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isDashAuthenticated(req)) {
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  const db = getSupabase();

  // GET — list pending
  if (req.method === 'GET') {
    const { data, error } = await db
      .from('pending_mappings')
      .select('*')
      .order('confidence', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) { res.status(500).json({ erro: error.message }); return; }
    res.status(200).json({ data });
    return;
  }

  // POST — approve or reject
  if (req.method === 'POST') {
    const body = req.body as { id?: string; action?: 'approve' | 'reject'; bling_product_id?: number; bling_sku?: string } | undefined;

    if (!body?.id || !body.action) {
      res.status(400).json({ erro: 'Campos obrigatórios: id, action (approve|reject)' });
      return;
    }

    const { data: pending, error: fetchErr } = await db
      .from('pending_mappings')
      .select('*')
      .eq('id', body.id)
      .single();

    if (fetchErr || !pending) {
      res.status(404).json({ erro: 'Mapeamento pendente não encontrado' });
      return;
    }

    if (body.action === 'approve') {
      const blingProductId = body.bling_product_id ?? (pending.bling_product_id as number);
      const blingSku = body.bling_sku ?? (pending.bling_sku as string);

      if (!blingProductId || !blingSku) {
        res.status(400).json({ erro: 'Informe bling_product_id e bling_sku para aprovar' });
        return;
      }

      // Guarda 1:1 — impede aprovar um vínculo cujo produto Bling já pertence a
      // outro código WMS ativo (causa histórica da quebra de estoque por variações).
      const conflict = await findConflictingWmsCode(blingProductId, pending.wms_code as string);
      if (conflict) {
        res.status(409).json({
          erro: `Produto Bling ${blingProductId} já está vinculado ao código WMS "${conflict}". ` +
            `Cada produto Bling só pode ter um código WMS ativo. Se são variações distintas, ` +
            `vincule cada uma ao ID da variação correspondente no Bling (não ao produto-pai).`,
        });
        return;
      }

      // Create confirmed mapping
      const { error: mapErr } = await db.from('product_mappings').insert({
        wms_code: pending.wms_code,
        bling_sku: blingSku,
        bling_product_id: blingProductId,
        active: true,
      });

      if (mapErr) {
        res.status(mapErr.code === '23505' ? 409 : 500).json({ erro: mapErr.message });
        return;
      }

      // Mark pending as approved
      await db
        .from('pending_mappings')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('id', body.id);

      res.status(200).json({ sucesso: true, action: 'approved' });
    } else {
      // Reject
      await db
        .from('pending_mappings')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', body.id);

      res.status(200).json({ sucesso: true, action: 'rejected' });
    }
    return;
  }

  // DELETE — remove entry
  if (req.method === 'DELETE') {
    const id = req.query['id'] as string | undefined;
    if (!id) { res.status(400).json({ erro: 'Query param id obrigatório' }); return; }

    const { error } = await db.from('pending_mappings').delete().eq('id', id);
    if (error) { res.status(500).json({ erro: error.message }); return; }
    res.status(200).json({ sucesso: true });
    return;
  }

  res.status(405).json({ erro: 'Método não permitido' });
}
