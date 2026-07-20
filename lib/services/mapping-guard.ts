import { getSupabase } from '../supabase';

/**
 * Guarda de integridade de vínculos: impõe a regra de negócio
 * "1 produto Bling ↔ no máximo 1 código WMS ativo".
 *
 * Contexto: a causa histórica de quebra de estoque foi múltiplas variações WMS
 * (ex.: JS200FAZ00M, JS200FPT00G, ...) colidindo no mesmo produto-pai do Bling.
 * Como cada expedição debitava o mesmo bling_product_id, o saldo do pai despencava
 * e o das variações nunca era tocado. Estas funções são chamadas ANTES de criar ou
 * aprovar qualquer vínculo ativo para transformar essa colisão silenciosa em uma
 * pendência visível de revisão manual.
 */

/**
 * Retorna o wms_code que já ocupa este bling_product_id de forma ativa
 * (ignorando exceptWmsCode), ou null se o produto Bling estiver livre.
 */
export async function findConflictingWmsCode(
  blingProductId: number,
  exceptWmsCode?: string
): Promise<string | null> {
  const db = getSupabase();
  let q = db
    .from('product_mappings')
    .select('wms_code')
    .eq('bling_product_id', blingProductId)
    .eq('active', true);
  if (exceptWmsCode) q = q.neq('wms_code', exceptWmsCode);

  const { data } = await q.limit(1);
  return data && data.length > 0 ? (data[0]!.wms_code as string) : null;
}

/**
 * Carrega um índice bling_product_id → wms_code de todos os vínculos ativos.
 * Usado em cargas em lote (catalog-sync) para evitar N+1 queries: o chamador
 * checa o Map em memória e o atualiza conforme cria novos vínculos no mesmo run.
 */
export async function loadActiveBlingProductIndex(): Promise<Map<number, string>> {
  const db = getSupabase();
  const { data } = await db
    .from('product_mappings')
    .select('wms_code, bling_product_id')
    .eq('active', true);

  const index = new Map<number, string>();
  for (const row of data ?? []) {
    index.set(row.bling_product_id as number, row.wms_code as string);
  }
  return index;
}
