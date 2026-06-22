import { logger } from '../logger';
import { fetchWithRetry } from '../fetchWithRetry';
import { getSetting } from '../settings';
import type {
  WMSCreateExpeditionPayload,
  WMSStockItem,
  WMSCatalogProduct,
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
 * Fetches the WMS product catalog with barcodes for cross-platform matching.
 * Tries the dedicated product endpoint first; falls back to stock balance.
 * The barcode field may be in codigoBarras, ean, gtin, or codBarras depending on WMS config.
 */
export async function listWMSProductCatalog(depositante: string): Promise<WMSCatalogProduct[]> {
  const baseUrl = await getBaseUrl();
  const apiKey = await getApiKey();
  const headers = { api_key: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };

  // Try dedicated product catalog endpoint (Smartgo /v2/produto/listar)
  const endpoints = [
    `/v2/produto/listar?docDepositante=${encodeURIComponent(depositante)}&limite=500`,
    `/v2/produto?docDepositante=${encodeURIComponent(depositante)}&limite=500`,
    `/estoque/v2/produto?docDepositante=${encodeURIComponent(depositante)}&limite=500`,
  ];

  for (const path of endpoints) {
    try {
      const res = await fetchWithRetry(`${baseUrl}${path}`, { method: 'GET', headers });
      if (res.ok) {
        const data = await res.json() as { itens?: WMSCatalogProduct[]; data?: WMSCatalogProduct[]; produtos?: WMSCatalogProduct[] };
        const items = data.itens ?? data.data ?? data.produtos ?? [];
        if (items.length > 0) {
          logger.info('wms-adapter', `WMS catalog fetched from ${path}`, { count: items.length });
          return items;
        }
      }
    } catch { /* try next */ }
  }

  // Fallback: stock balance has codes + names (may include barcodes as extra fields)
  try {
    const res = await fetchWithRetry(
      `${baseUrl}/estoque/v2/saldo-detalhado?docDepositante=${encodeURIComponent(depositante)}`,
      { method: 'GET', headers }
    );
    if (res.ok) {
      const data = await res.json() as { itens?: (WMSCatalogProduct & { saldoFisico?: number })[] };
      const items = (data.itens ?? []).map(i => ({
        codigoProduto: i.codigoProduto,
        descricao: i.descricao,
        codigoBarras: i.codigoBarras,
        ean: i.ean,
        gtin: i.gtin,
        codBarras: i.codBarras,
      }));
      logger.info('wms-adapter', 'WMS catalog via stock-balance fallback', { count: items.length });
      return items;
    }
  } catch { /* no-op */ }

  return [];
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

  // 200 = conectado com dados; 404 = conectado mas sem dados cadastrados ainda — ambos válidos
  return res.ok || res.status === 404;
}
