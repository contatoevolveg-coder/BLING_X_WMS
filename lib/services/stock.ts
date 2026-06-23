import { getSupabase } from '../supabase';
import { logger } from '../logger';
import { deductStock } from '../adapters/bling';
import { getSetting } from '../settings';
import { markQuarantine } from './queue';
import { tryAutoMap } from './auto-map';
import type {
  WebhookEvent,
  WMSWebhookPayload,
} from '../types';

async function getBlingDepositoId(): Promise<number> {
  const raw = await getSetting('BLING_DEPOSITO_ID').catch(
    () => process.env['BLING_DEPOSITO_ID'] ?? ''
  );
  const id = parseInt(raw, 10);
  if (!id) throw new Error('Missing or invalid BLING_DEPOSITO_ID (configure em system_settings ou env var)');
  return id;
}

/**
 * Retorna a data atual no formato YYYY-MM-DD para uso nas baixas do Bling.
 * @returns {string} Data em formato ISO (somente a parte da data).
 */
function todayISO(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

// ── Flow A: WMS → Bling baixa ────────────────────────────────

/**
 * PROCESSAMENTO DE BAIXA (WMS -> Bling)
 * Comunicação: Recebe um evento do WMS (Expedição Finalizada) e envia uma baixa de estoque (S) para o Bling.
 * 
 * 1. Extrai a lista de produtos recebidos do WMS.
 * 2. Consulta a tabela `product_mappings` no banco de dados (Supabase) para encontrar o ID correspondente no Bling.
 * 3. Se algum produto não estiver mapeado, o evento inteiro é colocado em quarentena.
 * 4. Dispara as chamadas para a API do Bling (`deductStock`) paralelamente em lotes (chunks) para evitar limite de requisições.
 * 
 * @param event O evento de webhook recuperado do banco de dados.
 */
export async function processBaixa(event: WebhookEvent): Promise<void> {
  const payload = event.payload as WMSWebhookPayload;
  const produtos = payload.metadata.produtos;
  const codigoInterno = payload.metadata.codigoInterno;
  const db = getSupabase();
  const depositoId = await getBlingDepositoId();
  const wmsCodes = produtos.map((p) => p.codigoProduto);

  // Evita erro na query do Supabase caso o array venha vazio
  if (wmsCodes.length === 0) {
    logger.warn('stock-service', 'Expedição sem produtos', { codigoInterno });
    return;
  }

  // Consulta todos os mapeamentos de uma só vez (Performance: previne N+1 queries)
  const { data: mappings, error: mappingError } = await db
    .from('product_mappings')
    .select('wms_code, bling_product_id')
    .in('wms_code', wmsCodes)
    .eq('active', true);

  if (mappingError) {
    throw new Error(`Falha ao buscar mapeamentos: ${mappingError.message}`);
  }

  // Busca na tabela processed_baixas para idempotência
  const { data: alreadyProcessed } = await db
    .from('processed_baixas')
    .select('wms_code')
    .eq('event_id', event.id)
    .in('wms_code', wmsCodes);

  const processedSet = new Set((alreadyProcessed || []).map((row) => row.wms_code));

  // Cria um dicionário em memória para acesso rápido O(1)
  const mappingsByWmsCode = new Map(
    mappings?.map((m) => [m.wms_code, m.bling_product_id as number])
  );

  const resolvedProducts: Array<{
    wms_code: string;
    bling_product_id: number;
    quantidade: number;
  }> = [];

  // Valida e prepara o payload para o Bling
  for (const produto of produtos) {
    if (processedSet.has(produto.codigoProduto)) {
      logger.info('stock', `Item ${produto.codigoProduto} ignorado na expedição ${event.id} (já processado)`);
      continue;
    }

    let blingProductId = mappingsByWmsCode.get(produto.codigoProduto);

    if (!blingProductId) {
      // Tenta auto-mapear antes de quarentenar
      const autoResult = await tryAutoMap(produto.codigoProduto);
      if (autoResult) {
        blingProductId = autoResult.blingProductId;
        logger.info('stock-service', `Auto-mapeamento aplicado para "${produto.codigoProduto}"`);
      } else {
        await markQuarantine(
          event.id,
          `Código WMS "${produto.codigoProduto}" sem mapeamento (expedição ${codigoInterno}). ` +
            `Sugestão salva em "Auto-scan" — reprocesse após aprovar.`
        );
        return;
      }
    }

    resolvedProducts.push({
      wms_code: produto.codigoProduto,
      bling_product_id: blingProductId,
      quantidade: produto.quantidade,
    });
  }

  if (resolvedProducts.length === 0) {
    logger.info('stock-service', `Expedição ${event.id} completamente processada (idempotência).`);
    return;
  }

  // Despacha as requisições para a API do Bling em blocos (chunks)
  // Isso acelera a baixa de múltiplos itens sem sobrecarregar a API remota (Rate Limit)
  const chunkSize = 5;
  for (let i = 0; i < resolvedProducts.length; i += chunkSize) {
    const chunk = resolvedProducts.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (resolved) => {
        // Faz a requisição na API do Bling
        await deductStock({
          operacao: 'S', // S = Saída (Baixa)
          preco: 0,
          custo: 0,
          data: todayISO(),
          produto: { id: resolved.bling_product_id },
          deposito: { id: depositoId },
          quantidade: resolved.quantidade,
          observacoes: `Baixa WMS Expedição ${codigoInterno}`,
        });
        
        // Grava no banco que este item já teve a baixa confirmada
        await db.from('processed_baixas').insert({
          wms_code: resolved.wms_code,
          event_id: event.id,
        });
      })
    );
  }

  logger.info('stock-service', 'Baixa de estoque concluída no Bling', {
    event_id: event.id,
    codigoInterno,
    product_count: resolvedProducts.length,
  });
}

