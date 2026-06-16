import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDetailedStockBalance } from '../../lib/adapters/wms';
import { listStockBalances } from '../../lib/adapters/bling';
import { getSupabase } from '../../lib/supabase';
import { logger } from '../../lib/logger';

interface Divergence {
  wms_code: string;
  bling_sku: string;
  wms_qty: number;
  bling_qty: number;
  delta: number;
}

/**
 * Runs every 30 minutes (see vercel.json).
 * Snapshots stock from both WMS and Bling, then logs any quantity divergences
 * using product_mappings as the join key.
 *
 * Divergences are logged as warnings — no auto-correction is performed.
 * A human must investigate and either trigger a manual reconciliation or
 * update the product_mappings table.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const runStart = Date.now();

  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const depositoId = parseInt(process.env['BLING_DEPOSITO_ID'] ?? '', 10);
  if (!depositoId) {
    res.status(500).json({ error: 'Missing or invalid BLING_DEPOSITO_ID' });
    return;
  }

  try {
    const [wmsItems, blingItems] = await Promise.all([
      getDetailedStockBalance(),
      listStockBalances(depositoId),
    ]);

    const snapshotAt = new Date().toISOString();
    const db = getSupabase();

    // Persist snapshots as append-only rows for historical analysis.
    const wmsRows = wmsItems.map((item) => ({
      source: 'wms' as const,
      product_code: item.codigoProduto,
      quantity: item.saldoFisico,
      snapshot_at: snapshotAt,
    }));

    const blingRows = blingItems.map((item) => ({
      source: 'bling' as const,
      product_code: item.produto.codigo,
      quantity: item.saldoFisico,
      snapshot_at: snapshotAt,
    }));

    if (wmsRows.length > 0) {
      const { error } = await db.from('stock_snapshots').insert(wmsRows);
      if (error) throw new Error(`WMS snapshot insert failed: ${error.message}`);
    }

    if (blingRows.length > 0) {
      const { error } = await db.from('stock_snapshots').insert(blingRows);
      if (error) throw new Error(`Bling snapshot insert failed: ${error.message}`);
    }

    // Compare via active product_mappings.
    const { data: mappings, error: mappingError } = await db
      .from('product_mappings')
      .select('wms_code, bling_sku')
      .eq('active', true);

    if (mappingError) throw new Error(`Mappings fetch failed: ${mappingError.message}`);

    const wmsMap = new Map(wmsItems.map((i) => [i.codigoProduto, i.saldoFisico]));
    const blingMap = new Map(blingItems.map((i) => [i.produto.codigo, i.saldoFisico]));

    const divergences: Divergence[] = [];

    for (const m of mappings ?? []) {
      const wmsQty = wmsMap.get(m.wms_code) ?? 0;
      const blingQty = blingMap.get(m.bling_sku) ?? 0;
      const delta = Math.abs(wmsQty - blingQty);

      if (delta > 0) {
        divergences.push({
          wms_code: m.wms_code,
          bling_sku: m.bling_sku,
          wms_qty: wmsQty,
          bling_qty: blingQty,
          delta,
        });
      }
    }

    if (divergences.length > 0) {
      logger.warn('reconcile', `${divergences.length} divergence(s) detected`, {
        divergences,
        duration_ms: Date.now() - runStart,
      });
    } else {
      logger.info('reconcile', 'Stock in sync', {
        wms_skus: wmsItems.length,
        bling_skus: blingItems.length,
        mapped_pairs: mappings?.length ?? 0,
        duration_ms: Date.now() - runStart,
      });
    }

    res.status(200).json({
      ok: true,
      wms_products: wmsItems.length,
      bling_products: blingItems.length,
      divergences: divergences.length,
      duration_ms: Date.now() - runStart,
    });
  } catch (err) {
    logger.error('reconcile', 'Reconciliation error', {
      error: String(err),
      duration_ms: Date.now() - runStart,
    });
    res.status(500).json({ ok: false, error: String(err) });
  }
}

function isAuthorized(req: VercelRequest): boolean {
  const cronSecret = process.env['CRON_SECRET'];
  if (!cronSecret) return true;
  return req.headers['authorization'] === `Bearer ${cronSecret}`;
}
