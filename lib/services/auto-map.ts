import { getSupabase } from '../supabase';
import { logger } from '../logger';
import { listProducts, searchProductsByCode } from '../adapters/bling';

function tokenSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
  const tokens = (s: string) =>
    new Set(norm(s).split(/\s+/).filter(Boolean));
  const ta = tokens(a), tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return Math.round((2 * common) / (ta.size + tb.size) * 100);
}

/**
 * Tries to find a Bling product match for an unmapped WMS code.
 *
 * Strategy:
 *  1. Return immediately if already mapped (active).
 *  2. Return null if a pending suggestion already exists.
 *  3. Search Bling by exact code → if unique match, auto-create mapping.
 *  4. Fuzzy token match on product name → save best suggestion to pending_mappings.
 *
 * Returns { blingProductId, blingSku } when a confirmed mapping is created,
 * or null when a pending suggestion was saved (needs human approval).
 */
export async function tryAutoMap(
  wmsCode: string,
  wmsProductName?: string
): Promise<{ blingProductId: number; blingSku: string } | null> {
  const db = getSupabase();

  // 1. Already has an active mapping?
  const { data: existing } = await db
    .from('product_mappings')
    .select('bling_product_id, bling_sku')
    .eq('wms_code', wmsCode)
    .eq('active', true)
    .maybeSingle();

  if (existing) {
    return {
      blingProductId: existing.bling_product_id as number,
      blingSku: existing.bling_sku as string,
    };
  }

  // 2. Already pending review?
  const { data: pendingExists } = await db
    .from('pending_mappings')
    .select('id')
    .eq('wms_code', wmsCode)
    .eq('status', 'pending')
    .maybeSingle();

  if (pendingExists) {
    logger.info('auto-map', `Pending suggestion already exists for "${wmsCode}"`);
    return null;
  }

  // 3. Exact code match in Bling
  const exactMatches = await searchProductsByCode(wmsCode);

  if (exactMatches.length === 1) {
    const m = exactMatches[0]!;
    const { error } = await db.from('product_mappings').insert({
      wms_code: wmsCode,
      bling_sku: m.codigo,
      bling_product_id: m.id,
      active: true,
    });

    if (!error) {
      logger.info('auto-map', `Auto-mapped "${wmsCode}" → Bling ${m.id} (exact code)`);
      return { blingProductId: m.id, blingSku: m.codigo };
    }
  }

  // 4. Fuzzy name match (fetch first page of Bling products)
  let bestScore = 0;
  let bestProduct: { id: number; nome: string; codigo: string } | null = null;

  const allProducts = await listProducts(1).catch(() => []);

  if (wmsProductName && allProducts.length > 0) {
    for (const p of allProducts) {
      const score = tokenSimilarity(wmsProductName, p.nome);
      if (score > bestScore) {
        bestScore = score;
        bestProduct = p;
      }
    }
  }

  // Prefer exact match suggestion over fuzzy when both exist
  const suggestion = exactMatches.length > 1 ? exactMatches[0] : (bestProduct ?? exactMatches[0]);
  const confidence = exactMatches.length === 1
    ? 100
    : exactMatches.length > 1
    ? 70
    : bestScore;
  const method: 'exact_code' | 'fuzzy_name' | 'manual' =
    exactMatches.length > 0 ? 'exact_code' : bestProduct ? 'fuzzy_name' : 'manual';

  // Save to pending_mappings for human approval
  await db.from('pending_mappings').insert({
    wms_code: wmsCode,
    wms_product_name: wmsProductName ?? null,
    bling_sku: suggestion?.codigo ?? null,
    bling_product_id: suggestion ? Number(suggestion.id) : null,
    bling_product_name: suggestion?.nome ?? null,
    confidence,
    match_method: method,
    status: 'pending',
  });

  logger.info('auto-map', `Saved pending mapping for "${wmsCode}"`, {
    confidence,
    method,
    suggestion: suggestion?.codigo ?? 'none',
  });

  return null;
}
