import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exchangeCodeForTokens } from '../../lib/adapters/bling';
import { logger } from '../../lib/logger';

/**
 * Step 2 of Bling OAuth 2.0 — exchange authorization code for tokens.
 *
 * Bling redirects here after the user approves the app:
 *   GET /api/auth/callback?code=<code>&state=<state>
 *
 * On success, tokens are stored in the bling_tokens table and the app is
 * ready to make API calls. This endpoint only needs to be visited once
 * (or whenever tokens need to be re-authorized).
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const { code, error, error_description } = req.query;

  if (error) {
    logger.error('auth-callback', 'Bling returned OAuth error', {
      error: String(error),
      description: String(error_description ?? ''),
    });
    res.status(400).json({
      ok: false,
      error: String(error),
      description: String(error_description ?? ''),
    });
    return;
  }

  if (!code) {
    res.status(400).json({ ok: false, error: 'Missing authorization code' });
    return;
  }

  const authCode = Array.isArray(code) ? code[0] : code;

  try {
    await exchangeCodeForTokens(authCode ?? '');
    logger.info('auth-callback', 'OAuth complete — SyncStock authorized');
    res.status(200).json({
      ok: true,
      message: 'Bling authorization complete. SyncStock is ready to process events.',
    });
  } catch (err) {
    logger.error('auth-callback', 'Token exchange failed', { error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
}
