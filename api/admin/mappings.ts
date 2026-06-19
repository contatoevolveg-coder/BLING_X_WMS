import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../../lib/supabase';
import { isDashAuthenticated } from '../../lib/auth';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isDashAuthenticated(req)) {
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  const db = getSupabase();

  // GET — list all mappings
  if (req.method === 'GET') {
    const { data, error } = await db
      .from('product_mappings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ erro: error.message });
      return;
    }

    res.status(200).json({ data });
    return;
  }

  // POST — create mapping
  if (req.method === 'POST') {
    const body = req.body as { wms_code?: string; bling_sku?: string; bling_product_id?: number } | undefined;

    if (!body?.wms_code || !body?.bling_sku || !body?.bling_product_id) {
      res.status(400).json({ erro: 'Campos obrigatórios: wms_code, bling_sku, bling_product_id' });
      return;
    }

    const { data, error } = await db
      .from('product_mappings')
      .insert({
        wms_code: body.wms_code.trim(),
        bling_sku: body.bling_sku.trim(),
        bling_product_id: Number(body.bling_product_id),
        active: true,
      })
      .select()
      .single();

    if (error) {
      res.status(error.code === '23505' ? 409 : 500).json({ erro: error.message });
      return;
    }

    res.status(201).json({ sucesso: true, data });
    return;
  }

  // PATCH — toggle active
  if (req.method === 'PATCH') {
    const body = req.body as { id?: string; active?: boolean } | undefined;

    if (!body?.id || body.active === undefined) {
      res.status(400).json({ erro: 'Campos obrigatórios: id, active' });
      return;
    }

    const { error } = await db
      .from('product_mappings')
      .update({ active: body.active, updated_at: new Date().toISOString() })
      .eq('id', body.id);

    if (error) {
      res.status(500).json({ erro: error.message });
      return;
    }

    res.status(200).json({ sucesso: true });
    return;
  }

  // DELETE — remove mapping
  if (req.method === 'DELETE') {
    const id = req.query['id'] as string | undefined;

    if (!id) {
      res.status(400).json({ erro: 'Query param id obrigatório' });
      return;
    }

    const { error } = await db.from('product_mappings').delete().eq('id', id);

    if (error) {
      res.status(500).json({ erro: error.message });
      return;
    }

    res.status(200).json({ sucesso: true });
    return;
  }

  res.status(405).json({ erro: 'Método não permitido' });
}
