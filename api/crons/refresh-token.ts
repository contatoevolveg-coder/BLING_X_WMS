import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../../lib/supabase';
import { logger } from '../../lib/logger';

const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';

function basicCredentials(): string {
  const id = process.env['BLING_CLIENT_ID'];
  const secret = process.env['BLING_CLIENT_SECRET'];
  if (!id || !secret) throw new Error('Missing BLING_CLIENT_ID or BLING_CLIENT_SECRET');
  return Buffer.from(`${id}:${secret}`).toString('base64');
}

function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env['CRON_SECRET'];
  if (!secret) return true;
  return req.headers['authorization'] === `Bearer ${secret}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  const db = getSupabase();

  const { data: token, error } = await db
    .from('bling_tokens')
    .select('refresh_token, expires_at, access_token')
    .eq('singleton_key', 'default')
    .single();

  if (error || !token) {
    logger.error('refresh-token', 'Token não encontrado no banco');
    res.status(500).json({ erro: 'Token não encontrado. Faça OAuth em /api/auth/start' });
    return;
  }

  const expiresAt = new Date(token.expires_at);
  const now = new Date();
  const minutesLeft = Math.round((expiresAt.getTime() - now.getTime()) / 60000);

  // Skip refresh if token still has more than 60 minutes left
  if (minutesLeft > 60) {
    logger.info('refresh-token', 'Token ainda válido, refresh ignorado', { minutesLeft });
    res.status(200).json({
      renovado: false,
      motivo: 'Token ainda válido',
      expira_em_minutos: minutesLeft,
      expira_em: expiresAt.toISOString(),
    });
    return;
  }

  logger.info('refresh-token', 'Renovando token Bling', { minutesLeft });

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });

  const refreshRes = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicCredentials()}`,
    },
    body: body.toString(),
  });

  if (!refreshRes.ok) {
    const text = await refreshRes.text();
    logger.error('refresh-token', 'Falha no refresh', { status: refreshRes.status, body: text });
    res.status(500).json({ erro: `Bling recusou o refresh (${refreshRes.status}): ${text}` });
    return;
  }

  const refreshed = (await refreshRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1_000).toISOString();

  const { error: upsertErr } = await db.from('bling_tokens').upsert(
    {
      singleton_key: 'default',
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'singleton_key' }
  );

  if (upsertErr) {
    logger.error('refresh-token', 'Falha ao salvar token renovado', { error: upsertErr.message });
    res.status(500).json({ erro: upsertErr.message });
    return;
  }

  logger.info('refresh-token', 'Token renovado com sucesso', { expira_em: newExpiresAt });

  res.status(200).json({
    renovado: true,
    expira_em: newExpiresAt,
    expira_em_minutos: Math.round(refreshed.expires_in / 60),
  });
}
