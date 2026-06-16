import { getSupabase } from '../supabase';
import { logger } from '../logger';
import { deductStock } from '../adapters/bling';
import { createExpeditionByProducts } from '../adapters/wms';
import { markQuarantine } from './queue';
import type {
  WebhookEvent,
  WMSWebhookPayload,
  BlingPedidoData,
  WMSExpeditionProduct,
} from '../types';

// situacaoId values that trigger a WMS expedition (Atendido=9, Em andamento=15)
const BLING_DISPATCH_STATUSES = new Set([9, 15]);

function getBlingDepositoId(): number {
  const raw = process.env['BLING_DEPOSITO_ID'];
  const id = parseInt(raw ?? '', 10);
  if (!id) throw new Error('Missing or invalid BLING_DEPOSITO_ID env var');
  return id;
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

// ── Flow A: WMS → Bling baixa ────────────────────────────────

/**
 * Processes a WMS EXPEDICAO/FINALIZADO event.
 * 1. Validates all product mappings exist before touching Bling.
 * 2. Posts one stock movement (baixa) per product to Bling.
 * 3. Quarantines the whole event if any product has no mapping.
 */
export async function processBaixa(event: WebhookEvent): Promise<void> {
  const payload = event.payload as WMSWebhookPayload;
  const produtos = payload.metadata.produtos;
  const codigoInterno = payload.metadata.codigoInterno;
  const db = getSupabase();
  const depositoId = getBlingDepositoId();

  // Resolve all mappings first — fail fast before any API calls.
  const resolvedProducts: Array<{
    bling_product_id: number;
    quantidade: number;
  }> = [];

  for (const produto of produtos) {
    const { data: mapping } = await db
      .from('product_mappings')
      .select('bling_product_id')
      .eq('wms_code', produto.codigoProduto)
      .eq('active', true)
      .maybeSingle();

    if (!mapping) {
      await markQuarantine(
        event.id,
        `No active mapping for WMS code "${produto.codigoProduto}" ` +
          `(expedição ${codigoInterno})`
      );
      return;
    }

    resolvedProducts.push({
      bling_product_id: mapping.bling_product_id as number,
      quantidade: produto.quantidade,
    });
  }

  // All mappings resolved — post baixas to Bling.
  for (const resolved of resolvedProducts) {
    await deductStock({
      operacao: 'S',
      preco: 0,
      custo: 0,
      data: todayISO(),
      produto: { id: resolved.bling_product_id },
      deposito: { id: depositoId },
      quantidade: resolved.quantidade,
      observacoes: `Baixa WMS Expedição ${codigoInterno}`,
    });
  }

  logger.info('stock-service', 'Baixa complete', {
    event_id: event.id,
    codigoInterno,
    product_count: resolvedProducts.length,
  });
}

// ── Flow B: Bling → WMS expedition ──────────────────────────

/**
 * Processes a Bling Pedido de Venda update event.
 * Only triggers when situacaoId is in BLING_DISPATCH_STATUSES.
 * 1. Maps Bling product IDs → WMS codes.
 * 2. Creates a WMS expedition via POST /v2/expedicao/por-produtos.
 */
export async function processExpedition(event: WebhookEvent): Promise<void> {
  const pedido = event.payload as BlingPedidoData;
  const situacaoId = pedido.situacao?.id;

  if (!situacaoId || !BLING_DISPATCH_STATUSES.has(situacaoId)) {
    // Event was enqueued but situação changed before processing — skip.
    logger.info('stock-service', 'Skipping Bling event — situação not dispatch-eligible', {
      event_id: event.id,
      pedido_id: pedido.id,
      situacao_id: situacaoId,
    });
    return;
  }

  const itens = pedido.itens;
  if (!itens?.length) {
    throw new Error(
      `Bling pedido ${pedido.id} has no itens — cannot create expedition`
    );
  }

  const depositante = process.env['WMS_DOC_DEPOSITANTE'];
  if (!depositante) throw new Error('Missing WMS_DOC_DEPOSITANTE');

  const db = getSupabase();
  const wmsProducts: WMSExpeditionProduct[] = [];

  for (const item of itens) {
    const { data: mapping } = await db
      .from('product_mappings')
      .select('wms_code')
      .eq('bling_product_id', item.produto.id)
      .eq('active', true)
      .maybeSingle();

    if (!mapping) {
      await markQuarantine(
        event.id,
        `No active mapping for Bling product ID ${item.produto.id} ` +
          `(código: "${item.produto.codigo}", pedido ${pedido.id})`
      );
      return;
    }

    wmsProducts.push({
      codigoProduto: mapping.wms_code as string,
      quantidade: item.quantidade,
    });
  }

  const result = await createExpeditionByProducts({
    codigoExterno: `BLING-${pedido.id}`,
    docDepositante: depositante,
    produtos: wmsProducts,
  });

  logger.info('stock-service', 'WMS expedition created', {
    event_id: event.id,
    bling_pedido_id: pedido.id,
    wms_codigoInterno: result.codigoInterno,
    product_count: wmsProducts.length,
  });
}
