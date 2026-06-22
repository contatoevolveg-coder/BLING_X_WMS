import { getSupabase } from '../supabase';
import { logger } from '../logger';
import { listAllProducts } from '../adapters/bling';
import { listWMSProductCatalog } from '../adapters/wms';
import { getSetting } from '../settings';
import type { SyncCatalogResult } from '../types';

// Exported so auto-map.ts can reuse without duplication
export function tokenSimilarity(a: string, b: string): number {
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

function normalizeBarcode(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\D/g, '').trim();
  return cleaned.length >= 8 ? cleaned : null;
}

function extractBarcode(item: Record<string, unknown>): string | null {
  for (const field of ['codigoBarras', 'ean', 'gtin', 'codBarras']) {
    const val = normalizeBarcode(item[field] as string | undefined);
    if (val) return val;
  }
  return null;
}

const BATCH = 50;

async function upsertBatch<T extends object>(
  table: string,
  rows: T[],
  onConflict: string
): Promise<void> {
  const db = getSupabase();
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + BATCH), { onConflict });
    if (error) logger.warn('catalog-sync', `Upsert error on ${table}`, { error: error.message });
  }
}

/**
 * Syncs the product catalog from Bling + WMS, then auto-creates mappings
 * for products that share the same EAN/GTIN barcode.
 *
 * Name priority: WMS name is used as display_name; falls back to Bling name.
 */
export async function syncProductCatalog(): Promise<SyncCatalogResult> {
  const t0 = Date.now();
  const db = getSupabase();

  // ── 1. Fetch products from both platforms ────────────────────
  const depositante = await getSetting('WMS_DOC_DEPOSITANTE').catch(
    () => process.env['WMS_DOC_DEPOSITANTE'] ?? ''
  );

  const [blingProducts, wmsProducts] = await Promise.all([
    listAllProducts(),
    depositante ? listWMSProductCatalog(depositante) : Promise.resolve([]),
  ]);

  logger.info('catalog-sync', 'Fetched products', {
    bling: blingProducts.length,
    wms: wmsProducts.length,
  });

  // ── 2. Upsert Bling products into product_catalog ───────────
  const blingRows = blingProducts.map(p => ({
    platform: 'bling',
    platform_id: String(p.id),
    code: p.codigo,
    name: p.nome,
    barcode: normalizeBarcode(p.gtin),
    synced_at: new Date().toISOString(),
  }));
  await upsertBatch('product_catalog', blingRows, 'platform,platform_id');

  // ── 3. Upsert WMS products into product_catalog ─────────────
  const wmsRows = wmsProducts.map(p => ({
    platform: 'wms',
    platform_id: p.codigoProduto,
    code: p.codigoProduto,
    name: p.descricao,
    barcode: extractBarcode(p as unknown as Record<string, unknown>),
    synced_at: new Date().toISOString(),
  }));
  await upsertBatch('product_catalog', wmsRows, 'platform,platform_id');

  // ── 4. Build in-memory indexes: barcode + code → Bling item ──
  const { data: blingCatalog } = await db
    .from('product_catalog')
    .select('platform_id, code, name, barcode')
    .eq('platform', 'bling');

  const blingByBarcode = new Map(
    (blingCatalog ?? []).filter(b => b.barcode).map(b => [b.barcode as string, b])
  );

  const blingByCode = new Map(
    (blingCatalog ?? []).map(b => [b.code.toLowerCase(), b])
  );

  // ── 5. Build in-memory index: code → WMS item ───────────────
  const { data: wmsCatalog } = await db
    .from('product_catalog')
    .select('code, name, barcode')
    .eq('platform', 'wms');

  // ── 6. Load existing mappings + pending to avoid duplicates ──
  const { data: existingMaps } = await db
    .from('product_mappings')
    .select('wms_code')
    .eq('active', true);
  const mappedCodes = new Set((existingMaps ?? []).map(m => m.wms_code as string));

  const { data: existingPending } = await db
    .from('pending_mappings')
    .select('wms_code')
    .eq('status', 'pending');
  const pendingCodes = new Set((existingPending ?? []).map(m => m.wms_code as string));

  // ── 7. Auto-map by barcode (confidence 100) ──────────────────
  let autoMapped = 0;
  let pendingCreated = 0;

  const mappingsToInsert: object[] = [];
  const pendingToInsert: object[] = [];

  for (const wmsItem of (wmsCatalog ?? [])) {
    if (mappedCodes.has(wmsItem.code) || pendingCodes.has(wmsItem.code)) continue;

    // Try barcode match first
    if (wmsItem.barcode) {
      const blingMatch = blingByBarcode.get(wmsItem.barcode);
      if (blingMatch) {
        mappingsToInsert.push({
          wms_code: wmsItem.code,
          bling_sku: blingMatch.code,
          bling_product_id: parseInt(blingMatch.platform_id),
          barcode: wmsItem.barcode,
          display_name: wmsItem.name || blingMatch.name,
          active: true,
        });
        mappedCodes.add(wmsItem.code);
        autoMapped++;
        logger.info('catalog-sync', `Barcode match: "${wmsItem.code}" → "${blingMatch.code}" (${wmsItem.barcode})`);
        continue;
      }
    }

    // Try exact code match (WMS code = Bling code, case-insensitive)
    const codeMatch = blingByCode.get(wmsItem.code.toLowerCase());
    if (codeMatch) {
      mappingsToInsert.push({
        wms_code: wmsItem.code,
        bling_sku: codeMatch.code,
        bling_product_id: parseInt(codeMatch.platform_id),
        barcode: wmsItem.barcode ?? null,
        display_name: wmsItem.name || codeMatch.name,
        active: true,
      });
      mappedCodes.add(wmsItem.code);
      autoMapped++;
      logger.info('catalog-sync', `Code match: "${wmsItem.code}" → "${codeMatch.code}"`);
      continue;
    }

    // ── 8. Fuzzy name match for unmapped items ───────────────
    if (!wmsItem.name) continue;

    let bestScore = 0;
    let bestBling: { platform_id: any; code: any; name: any; barcode: any } | null = null;

    for (const b of (blingCatalog ?? [])) {
      const score = tokenSimilarity(wmsItem.name, b.name);
      if (score > bestScore) { bestScore = score; bestBling = b; }
    }

    if (bestScore >= 40 && bestBling) {
      pendingToInsert.push({
        wms_code: wmsItem.code,
        wms_product_name: wmsItem.name,
        wms_barcode: wmsItem.barcode ?? null,
        bling_sku: bestBling.code,
        bling_product_id: parseInt(bestBling.platform_id),
        bling_product_name: bestBling.name,
        bling_barcode: bestBling.barcode ?? null,
        confidence: bestScore,
        match_method: 'fuzzy_name',
        status: 'pending',
      });
      pendingCodes.add(wmsItem.code);
      pendingCreated++;
    }
  }

  // Batch insert new mappings + pending suggestions
  if (mappingsToInsert.length > 0) {
    await upsertBatch('product_mappings', mappingsToInsert, 'wms_code');
  }
  if (pendingToInsert.length > 0) {
    await upsertBatch('pending_mappings', pendingToInsert, 'wms_code,status');
  }

  const result: SyncCatalogResult = {
    bling_synced: blingProducts.length,
    wms_synced: wmsProducts.length,
    auto_mapped: autoMapped,
    pending_created: pendingCreated,
    duration_ms: Date.now() - t0,
  };

  logger.info('catalog-sync', 'Sync complete', { ...result });
  return result;
}
