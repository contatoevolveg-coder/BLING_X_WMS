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
 * CRON DE RECONCILIAÇÃO (Executa a cada 30 minutos, definido no vercel.json)
 * 
 * Comunicação: 
 * - Busca todos os estoques do WMS via API `getDetailedStockBalance`.
 * - Busca todos os estoques do Bling via API `listStockBalances`.
 * - Compara os saldos físicos utilizando a tabela `product_mappings` como ponte (join key).
 * 
 * O objetivo é identificar divergências entre as duas plataformas e registrá-las
 * nos logs do sistema (divergências geram logs de warning).
 * Nenhuma correção automática é feita; apenas alertas para investigação humana.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const runStart = Date.now();

  if (!isAuthorized(req)) {
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  const depositoId = parseInt(process.env['BLING_DEPOSITO_ID'] ?? '', 10);
  if (!depositoId) {
    res.status(500).json({ erro: 'Variável BLING_DEPOSITO_ID ausente ou inválida' });
    return;
  }

  try {
    const [wmsItems, blingItems] = await Promise.all([
      getDetailedStockBalance(),
      listStockBalances(depositoId),
    ]);

    const snapshotAt = new Date().toISOString();
    const db = getSupabase();

    // Salva o snapshot dos estoques para fins de histórico e auditoria
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

    // Helper para inserir dados em lotes e evitar erro de 'Payload Too Large'
    const chunkInsert = async (table: string, rows: Record<string, unknown>[], chunkSize = 500) => {
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const { error } = await db.from(table).insert(chunk);
        if (error) throw new Error(`Falha ao inserir lote na tabela ${table}: ${error.message}`);
      }
    };

    if (wmsRows.length > 0) {
      await chunkInsert('stock_snapshots', wmsRows);
    }

    if (blingRows.length > 0) {
      await chunkInsert('stock_snapshots', blingRows);
    }

    // Compara os itens com base nos mapeamentos de produtos ativos
    let allMappings: Record<string, unknown>[] = [];
    let from = 0;
    const step = 1000;
    
    // Paginação para evitar limite padrão de 1000 rows do Supabase
    while (true) {
      const { data, error: mappingError } = await db
        .from('product_mappings')
        .select('wms_code, bling_sku')
        .eq('active', true)
        .range(from, from + step - 1);

      if (mappingError) throw new Error(`Falha ao buscar mapeamentos: ${mappingError.message}`);
      if (!data || data.length === 0) break;
      
      allMappings.push(...data);
      if (data.length < step) break;
      from += step;
    }
    const mappings = allMappings as Array<{ wms_code: string; bling_sku: string }>;

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
      logger.warn('reconcile', `${divergences.length} divergência(s) detectada(s)`, {
        divergences,
        duracao_ms: Date.now() - runStart,
      });
    } else {
      logger.info('reconcile', 'Estoque sincronizado', {
        wms_skus: wmsItems.length,
        bling_skus: blingItems.length,
        mapped_pairs: mappings?.length ?? 0,
        duracao_ms: Date.now() - runStart,
      });
    }

    res.status(200).json({
      sucesso: true,
      produtos_wms: wmsItems.length,
      produtos_bling: blingItems.length,
      divergencias: divergences.length,
      duracao_ms: Date.now() - runStart,
    });
  } catch (err) {
    logger.error('reconcile', 'Erro na reconciliação', {
      erro: String(err),
      duracao_ms: Date.now() - runStart,
    });
    res.status(500).json({ sucesso: false, erro: String(err) });
  }
}

function isAuthorized(req: VercelRequest): boolean {
  const cronSecret = process.env['CRON_SECRET'];
  if (!cronSecret) return true;
  return req.headers['authorization'] === `Bearer ${cronSecret}`;
}
