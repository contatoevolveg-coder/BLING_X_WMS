import { getSupabase } from '../supabase';
import { logger } from '../logger';
import { deductStock, getOrderById } from '../adapters/bling';
import { getSetting } from '../settings';
import { createExpeditionByProducts } from '../adapters/wms';
import { markQuarantine } from './queue';
import { tryAutoMap } from './auto-map';
import type {
  WebhookEvent,
  WMSWebhookPayload,
  BlingPedidoData,
  WMSExpeditionProduct,
} from '../types';

// Valores de situacaoId do Bling que acionam uma expedição no WMS (Atendido=9, Em andamento=15)
const BLING_DISPATCH_STATUSES = new Set([9, 15]);

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

// ── Flow B: Bling → WMS expedition ──────────────────────────

/**
 * PROCESSAMENTO DE EXPEDIÇÃO (Bling -> WMS)
 * Comunicação: Recebe um evento do Bling (Pedido Atualizado) e cria uma ordem de expedição no WMS.
 * 
 * 1. Verifica se o status do pedido exige envio ao WMS.
 * 2. Consulta os mapeamentos no Supabase para traduzir IDs do Bling para Códigos do WMS.
 * 3. Se houver falha de mapeamento, o evento é quarentenado.
 * 4. Faz uma requisição à API do WMS (`createExpeditionByProducts`) para registrar a expedição.
 * 
 * @param event O evento de webhook recuperado do banco de dados.
 */
export async function processExpedition(event: WebhookEvent): Promise<void> {
  const pedido = event.payload as BlingPedidoData;
  const situacaoId = pedido.situacao?.id;

  // Ignora se a situação não faz parte daquelas que exigem separação/expedição
  if (!situacaoId || !BLING_DISPATCH_STATUSES.has(situacaoId)) {
    logger.info('stock-service', 'Evento do Bling ignorado — situação não aciona expedição', {
      event_id: event.id,
      pedido_id: pedido.id,
      situacao_id: situacaoId,
    });
    return;
  }

  // Webhook only sends the order header — fetch full order if itens are missing
  let itens = pedido.itens;
  if (!itens?.length) {
    const fullOrder = await getOrderById(pedido.id);
    itens = fullOrder.itens;
  }
  if (!itens?.length) {
    throw new Error(
      `Pedido Bling ${pedido.id} não possui itens — impossível criar expedição`
    );
  }

  const depositante = await getSetting('WMS_DOC_DEPOSITANTE');

  const db = getSupabase();
  const wmsProducts: WMSExpeditionProduct[] = [];

  const blingProductIds = itens.map((item) => item.produto.id);

  // Evita erro no Supabase caso array esteja vazio (apesar do check de length acima garantir)
  if (blingProductIds.length === 0) return;

  // Busca no Supabase os mapeamentos de todos os itens do pedido em uma única query
  const { data: mappings, error: mappingError } = await db
    .from('product_mappings')
    .select('wms_code, bling_product_id')
    .in('bling_product_id', blingProductIds)
    .eq('active', true);

  if (mappingError) {
    throw new Error(`Falha ao buscar mapeamentos: ${mappingError.message}`);
  }

  const mappingsByBlingId = new Map(
    mappings?.map((m) => [m.bling_product_id, m.wms_code as string])
  );

  // Valida e traduz os itens do pedido Bling para o formato exigido pelo WMS
  for (const item of itens) {
    let wmsCode = mappingsByBlingId.get(item.produto.id);

    if (!wmsCode) {
      const autoResult = await tryAutoMap(item.produto.codigo, item.produto.nome);
      if (autoResult) {
        // Auto-mapeou: busca o wms_code que foi criado
        const { data: newMap } = await getSupabase()
          .from('product_mappings')
          .select('wms_code')
          .eq('bling_product_id', item.produto.id)
          .eq('active', true)
          .single();
        wmsCode = newMap?.wms_code as string | undefined;
      }
      if (!wmsCode) {
        await markQuarantine(
          event.id,
          `Produto Bling ID ${item.produto.id} ("${item.produto.codigo}") sem mapeamento ` +
            `(pedido ${pedido.id}). Sugestão salva em "Auto-scan" — reprocesse após aprovar.`
        );
        return;
      }
    }

    wmsProducts.push({
      codigoProduto: wmsCode,
      quantidade: item.quantidade,
    });
  }

  // Comunicação de Saída: Chama a API do WMS para criar a expedição
  let result: { codigoInterno: string };
  try {
    result = await createExpeditionByProducts({
      codigoExterno: `BLING-${pedido.id}`,
      docDepositante: depositante,
      produtos: wmsProducts,
    });
  } catch (err) {
    const msg = String(err);
    // WMS retorna 404 quando a conta não está configurada para expedições
    if (msg.includes('404')) {
      await markQuarantine(
        event.id,
        `WMS não aceitou a expedição (404) para pedido Bling ${pedido.id}. ` +
        `Verifique se o depositante está habilitado para criar expedições no Smartgo. Erro: ${msg}`
      );
      return;
    }
    throw err;
  }

  logger.info('stock-service', 'Expedição criada no WMS com sucesso', {
    event_id: event.id,
    bling_pedido_id: pedido.id,
    wms_codigoInterno: result.codigoInterno,
    product_count: wmsProducts.length,
  });
}
