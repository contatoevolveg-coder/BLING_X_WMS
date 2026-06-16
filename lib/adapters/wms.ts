import { logger } from '../logger';
import type {
  WMSCreateExpeditionPayload,
  WMSStockItem,
} from '../types';

function getBaseUrl(): string {
  return process.env['WMS_BASE_URL'] ?? 'https://apigateway.smartgo.com.br';
}

function getApiKey(): string {
  const key = process.env['WMS_API_KEY'];
  if (!key) throw new Error('Missing WMS_API_KEY');
  return key;
}

async function wmsRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      api_key: getApiKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WMS ${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Creates an expedition order in the WMS from a list of products.
 * Endpoint: POST /v2/expedicao/por-produtos
 */
export async function createExpeditionByProducts(
  payload: WMSCreateExpeditionPayload
): Promise<{ codigoInterno: string }> {
  const result = await wmsRequest<{ codigoInterno: string }>(
    'POST',
    '/v2/expedicao/por-produtos',
    payload
  );
  logger.info('wms-adapter', 'Expedition created', {
    codigoExterno: payload.codigoExterno,
    product_count: payload.produtos.length,
    codigoInterno: result.codigoInterno,
  });
  return result;
}

/**
 * Fetches detailed stock balance for the configured depositante.
 * Endpoint: GET /estoque/v2/saldo-detalhado
 */
export async function getDetailedStockBalance(): Promise<WMSStockItem[]> {
  const depositante = process.env['WMS_DOC_DEPOSITANTE'];
  if (!depositante) throw new Error('Missing WMS_DOC_DEPOSITANTE');

  const result = await wmsRequest<{ itens?: WMSStockItem[] }>(
    'GET',
    `/estoque/v2/saldo-detalhado?docDepositante=${encodeURIComponent(depositante)}`
  );

  return result.itens ?? [];
}

/**
 * Fetches a single expedition by its internal code.
 * Endpoint: GET /v2/expedicao
 */
export async function getExpedition(codigoInterno: string): Promise<unknown> {
  return wmsRequest<unknown>(
    'GET',
    `/v2/expedicao?codigoInterno=${encodeURIComponent(codigoInterno)}`
  );
}
