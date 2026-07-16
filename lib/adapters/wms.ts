import { logger } from '../logger';
import { fetchWithRetry } from '../fetchWithRetry';
import { getSetting } from '../settings';
import type {
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
 * Fetches detailed stock balance for the configured depositante.
 * Endpoint: GET /estoque/v2/saldo-detalhado
 */
export async function getDetailedStockBalance(): Promise<WMSStockItem[]> {
  const depositante = await getSetting('WMS_DOC_DEPOSITANTE');

  const allItems: WMSStockItem[] = [];
  let page = 1;
  const limite = 500;

  while (true) {
    const result = await wmsRequest<{ itens?: WMSStockItem[] }>(
      'GET',
      `/estoque/v2/saldo-detalhado?docDepositante=${encodeURIComponent(depositante)}&limite=${limite}&pagina=${page}`
    );
    const items = result.itens ?? [];
    allItems.push(...items);
    
    if (items.length < limite) break;
    page++;
  }

  return allItems;
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
    `/v2/produto/listar`,
    `/v2/produto`,
    `/estoque/v2/produto`,
  ];

  for (const path of endpoints) {
    try {
      const allItems: WMSCatalogProduct[] = [];
      let page = 1;
      const limite = 500;
      let success = false;

      while (true) {
        const res = await fetchWithRetry(`${baseUrl}${path}?docDepositante=${encodeURIComponent(depositante)}&limite=${limite}&pagina=${page}`, { method: 'GET', headers });
        if (!res.ok) break;

        success = true;
        const data = await res.json() as { itens?: WMSCatalogProduct[]; data?: WMSCatalogProduct[]; produtos?: WMSCatalogProduct[] };
        const items = data.itens ?? data.data ?? data.produtos ?? [];
        allItems.push(...items);
        
        if (items.length < limite) break;
        page++;
      }

      if (success && allItems.length > 0) {
        logger.info('wms-adapter', `WMS catalog fetched from ${path}`, { count: allItems.length, pages: page });
        return allItems;
      }
    } catch { /* try next */ }
  }

  // Fallback: stock balance has codes + names (may include barcodes as extra fields)
  try {
    const allItems: WMSCatalogProduct[] = [];
    let page = 1;
    const limite = 500;

    while (true) {
      const res = await fetchWithRetry(
        `${baseUrl}/estoque/v2/saldo-detalhado?docDepositante=${encodeURIComponent(depositante)}&limite=${limite}&pagina=${page}`,
        { method: 'GET', headers }
      );
      if (!res.ok) break;

      const data = await res.json() as { itens?: (WMSCatalogProduct & { saldoFisico?: number })[] };
      const fetchedItems = data.itens ?? [];
      
      const mappedItems = fetchedItems.map(i => ({
        codigoProduto: i.codigoProduto,
        descricao: i.descricao,
        codigoBarras: i.codigoBarras,
        ean: i.ean,
        gtin: i.gtin,
        codBarras: i.codBarras,
      }));
      
      allItems.push(...mappedItems);
      
      if (fetchedItems.length < limite) break;
      page++;
    }

    if (allItems.length > 0) {
      logger.info('wms-adapter', 'WMS catalog via stock-balance fallback', { count: allItems.length, pages: page });
      return allItems;
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
