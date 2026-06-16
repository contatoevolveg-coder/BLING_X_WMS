import { getSupabase } from '../supabase';
import { logger } from '../logger';
import type { BlingStockMovement, BlingToken } from '../types';

const BLING_BASE_URL = 'https://www.bling.com.br/Api/v3';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const BLING_AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const TOKEN_REFRESH_BUFFER_MS = 60_000;

function basicCredentials(): string {
  const id = process.env['BLING_CLIENT_ID'];
  const secret = process.env['BLING_CLIENT_SECRET'];
  if (!id || !secret) throw new Error('Missing BLING_CLIENT_ID or BLING_CLIENT_SECRET');
  return Buffer.from(`${id}:${secret}`).toString('base64');
}

async function getValidAccessToken(): Promise<string> {
  const db = getSupabase();

  const { data, error } = await db
    .from('bling_tokens')
    .select('*')
    .eq('singleton_key', 'default')
    .single();

  if (error || !data) {
    throw new Error(
      'Bling OAuth tokens not found. Visit /api/auth/start to authorize the app.'
    );
  }

  const token = data as BlingToken;
  const expiresAt = new Date(token.expires_at).getTime();

  if (expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return token.access_token;
  }

  // Token is expired or about to expire — refresh it.
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });

  const res = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicCredentials()}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bling token refresh failed (${res.status}): ${text}`);
  }

  const refreshed = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newExpiresAt = new Date(
    Date.now() + refreshed.expires_in * 1_000
  ).toISOString();

  const { error: upsertError } = await db.from('bling_tokens').upsert(
    {
      singleton_key: 'default',
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'singleton_key' }
  );

  if (upsertError) {
    throw new Error(`Failed to persist refreshed tokens: ${upsertError.message}`);
  }

  logger.info('bling-adapter', 'Access token refreshed');
  return refreshed.access_token;
}

async function blingRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const accessToken = await getValidAccessToken();
  const url = `${BLING_BASE_URL}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bling ${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Inserts a stock movement into Bling (baixa = operacao "S", entrada = "E").
 * Endpoint: POST /Api/v3/estoques
 */
export async function deductStock(movement: BlingStockMovement): Promise<void> {
  await blingRequest<unknown>('POST', '/estoques', movement);
  logger.info('bling-adapter', 'Stock movement recorded', {
    operacao: movement.operacao,
    product_id: movement.produto.id,
    qty: movement.quantidade,
    deposito_id: movement.deposito.id,
  });
}

/**
 * Returns current stock balances for a given deposit.
 * Endpoint: GET /Api/v3/estoques?idDeposito=<id>
 */
export async function listStockBalances(depositoId: number): Promise<
  Array<{
    produto: { id: number; codigo: string; nome?: string };
    saldoFisico: number;
    saldoVirtual?: number;
  }>
> {
  const res = await blingRequest<{
    data: Array<{
      produto: { id: number; codigo: string; nome?: string };
      saldoFisico: number;
      saldoVirtual?: number;
    }>;
  }>('GET', `/estoques?idDeposito=${depositoId}&pagina=1&limite=500`);
  return res.data ?? [];
}

/**
 * Lists Bling products (used for mapping seeding).
 */
export async function listProducts(
  page = 1
): Promise<Array<{ id: number; nome: string; codigo: string }>> {
  const res = await blingRequest<{
    data: Array<{ id: number; nome: string; codigo: string }>;
  }>('GET', `/produtos?pagina=${page}&limite=100`);
  return res.data ?? [];
}

/**
 * Exchanges an OAuth authorization code for access + refresh tokens
 * and persists them in the bling_tokens table.
 */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const redirectUri = process.env['BLING_REDIRECT_URI'];
  if (!redirectUri) throw new Error('Missing BLING_REDIRECT_URI');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicCredentials()}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  const expiresAt = new Date(
    Date.now() + tokens.expires_in * 1_000
  ).toISOString();

  const db = getSupabase();
  const { error } = await db.from('bling_tokens').upsert(
    {
      singleton_key: 'default',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      scope: tokens.scope ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'singleton_key' }
  );

  if (error) throw new Error(`Failed to persist tokens: ${error.message}`);

  logger.info('bling-adapter', 'OAuth tokens exchanged and stored');
}

/**
 * Builds the Bling OAuth 2.0 authorization URL.
 * The `scope` parameter is intentionally omitted — all scopes are
 * pre-configured in App 338063 on the Bling developer portal.
 */
export function buildAuthUrl(state: string): string {
  const clientId = process.env['BLING_CLIENT_ID'];
  const redirectUri = process.env['BLING_REDIRECT_URI'];
  if (!clientId || !redirectUri) {
    throw new Error('Missing BLING_CLIENT_ID or BLING_REDIRECT_URI');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });

  return `${BLING_AUTH_URL}?${params.toString()}`;
}
