import { logger } from '../logger';
import { fetchWithRetry } from '../fetchWithRetry';
import { getSetting } from '../settings';
import type {
  WMSCreateExpeditionPayload,
  WMSStockItem,
} from '../types';

async function getBaseUrl(): Promise<string> {
  try {
    return await getSetting('WMS_BASE_URL');
  } catch {
    return 'https://apigateway.smartgo.com.br';
  }
}

async function getApiKey(): Promise<string> {
  return await getSetting('WMS_API_KEY');
}

async function wmsRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const baseUrl = await getBaseUrl();
  const url = `${baseUrl}${path}`;
  const apiKey = await getApiKey();

  const res = await fetchWithRetry(url, {
    method,
    headers: {
      api_key: apiKey,
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

// ── API Pública do Adaptador ───────────────────────────────────────────────

/**
 * Cria uma nova ordem de expedição no WMS a partir de uma lista de produtos.
 * Comunicação: POST /v2/expedicao/por-produtos (API WMS).
 * Acionado sempre que um pedido elegível é criado/atualizado no Bling.
 * 
 * @param payload Dados da expedição (código externo, depositante e lista de produtos)
 * @returns O código interno gerado pelo WMS para a expedição criada
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
  const depositante = await getSetting('WMS_DOC_DEPOSITANTE');

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

/**
 * Pings the WMS API to verify connection settings.
 * Fetches 1 item from the stock balance to ensure credentials are correct.
 */
export async function pingWmsConnection(
  apiKey: string,
  baseUrl: string,
  depositante: string
): Promise<boolean> {
  const url = `${baseUrl}/estoque/v2/saldo-detalhado?docDepositante=${encodeURIComponent(depositante)}&limite=1`;
  
  const res = await fetchWithRetry(url, {
    method: 'GET',
    headers: {
      api_key: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  return res.ok;
}
