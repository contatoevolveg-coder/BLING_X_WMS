import { getSupabase } from '../supabase';
import { logger } from '../logger';
import { listProducts, searchProductsByCode } from '../adapters/bling';
import { tokenSimilarity } from './catalog-sync';

/**
 * Tries to find and create a Bling product mapping for an unmapped WMS code.
 *
 * Strategy (in order):
 *  1. Return immediately if an active mapping already exists.
 *  2. Return null if a pending suggestion already exists (avoid spam).
 *  3. Barcode match via product_catalog (confidence 100 — auto-creates mapping).
 *  4. Exact Bling code search via API (confidence 100 if unique).
 *  5. Fuzzy name match via product_catalog or Bling API page 1.
 *  6. Save best suggestion to pending_mappings for human approval.
 *
 * Name priority: WMS name > Bling name (per business rule).
 *
 * Returns { blingProductId, blingSku } when a confirmed mapping is created,
 * or null when only a pending suggestion was saved.
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

  // 3. Barcode match via product_catalog
  const { data: wmsEntry } = await db
    .from('product_catalog')
    .select('barcode, name')
    .eq('platform', 'wms')
    .eq('code', wmsCode)
    .maybeSingle();

  const wmsBarcode = (wmsEntry?.barcode as string | null) ?? null;
  const wmsName = wmsProductName ?? (wmsEntry?.name as string | null) ?? undefined;

  if (wmsBarcode) {
    const { data: blingEntry } = await db
      .from('product_catalog')
      .select('platform_id, code, name, barcode')
      .eq('platform', 'bling')
      .eq('barcode', wmsBarcode)
      .maybeSingle();

    if (blingEntry) {
      const displayName = wmsName ?? (blingEntry.name as string);
      const blingId = parseInt(blingEntry.platform_id as string);
      const blingSku = blingEntry.code as string;

      const { error } = await db.from('product_mappings').insert({
        wms_code: wmsCode,
        bling_sku: blingSku,
        bling_product_id: blingId,
        barcode: wmsBarcode,
        display_name: displayName,
        active: true,
      });

      if (!error || error.code === '23505') {
        if (!error) logger.info('auto-map', `Barcode match: "${wmsCode}" → Bling "${blingSku}" (${wmsBarcode})`);
        else logger.info('auto-map', `Concurrent barcode mapping detected for "${wmsCode}" (23505)`);
        return { blingProductId: blingId, blingSku };
      }
    }
  }

  // 4. Exact code match in Bling API
  const exactMatches = await searchProductsByCode(wmsCode);

  if (exactMatches.length === 1) {
    const m = exactMatches[0]!;
    const displayName = wmsName ?? m.nome;
    const { error } = await db.from('product_mappings').insert({
      wms_code: wmsCode,
      bling_sku: m.codigo,
      bling_product_id: m.id,
      barcode: m.gtin ?? null,
      display_name: displayName,
      active: true,
    });
    if (!error || error.code === '23505') {
      if (!error) logger.info('auto-map', `Exact code match: "${wmsCode}" → Bling ${m.id}`);
      else logger.info('auto-map', `Concurrent exact code mapping detected for "${wmsCode}" (23505)`);
      return { blingProductId: m.id, blingSku: m.codigo };
    }
  }

  // 5. Fuzzy name match — prefer catalog (fast), fall back to Bling API
  let bestScore = 0;
  let bestProduct: { id: number; nome: string; codigo: string; gtin?: string } | null = null;

  const { data: catalogBling } = await db
    .from('product_catalog')
    .select('platform_id, code, name, barcode')
    .eq('platform', 'bling');

  if (wmsName && catalogBling && catalogBling.length > 0) {
    for (const b of catalogBling) {
      const score = tokenSimilarity(wmsName, b.name as string);
      if (score > bestScore) {
        bestScore = score;
        bestProduct = {
          id: parseInt(b.platform_id as string),
          nome: b.name as string,
          codigo: b.code as string,
          gtin: (b.barcode as string | null) ?? undefined,
        };
      }
    }
  } else if (wmsName) {
    // Catalog not yet synced — hit Bling API directly
    const allProducts = await listProducts(1).catch(() => []);
    for (const p of allProducts) {
      const score = tokenSimilarity(wmsName, p.nome);
      if (score > bestScore) { bestScore = score; bestProduct = p; }
    }
  }

  // Pick best suggestion between multiple exact-code results vs fuzzy
  const suggestion = exactMatches.length > 1
    ? exactMatches[0]!
    : (bestProduct ?? (exactMatches[0] ?? null));

  const confidence = exactMatches.length === 1
    ? 100
    : exactMatches.length > 1
    ? 70
    : bestScore;

  const method: 'barcode' | 'exact_code' | 'fuzzy_name' | 'manual' =
    exactMatches.length > 0 ? 'exact_code' : bestProduct ? 'fuzzy_name' : 'manual';

  const { error: insertError } = await db.from('pending_mappings').insert({
    wms_code: wmsCode,
    wms_product_name: wmsName ?? null,
    wms_barcode: wmsBarcode,
    bling_sku: suggestion?.codigo ?? null,
    bling_product_id: suggestion ? Number(suggestion.id) : null,
    bling_product_name: suggestion?.nome ?? null,
    bling_barcode: suggestion?.gtin ?? null,
    confidence,
    match_method: method,
    status: 'pending',
  });

  if (insertError && insertError.code !== '23505') {
    logger.error('auto-map', `Failed to save pending mapping for "${wmsCode}"`, { error: insertError.message });
  } else if (!insertError) {
    logger.info('auto-map', `Saved pending mapping for "${wmsCode}"`, {
      confidence,
      method,
      suggestion: suggestion?.codigo ?? 'none',
    });
  } else {
    logger.info('auto-map', `Concurrent pending mapping detected for "${wmsCode}" (23505)`);
  }

  return null;
}
