import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildAuthUrl } from '../../lib/adapters/bling';
import { logger } from '../../lib/logger';

/**
 * Step 1 of Bling OAuth 2.0.
 *
 * Visit this endpoint once from a browser to authorize the app:
 *   GET https://syncstock.vercel.app/api/auth/start
 *
 * It redirects to Bling's consent screen. After approval, Bling redirects
 * back to /api/auth/callback which exchanges the code for tokens.
 *
 * Protect this endpoint in production with a firewall rule or basic auth
 * so it can only be reached by the app owner.
 */
export default function handler(req: VercelRequest, res: VercelResponse): void {
  try {
    // The state value is an opaque random string used to prevent CSRF.
    // A production implementation would store this in a short-lived session
    // and verify it in the callback. For an internal-only tool, a random
    // timestamp is sufficient.
    const state = Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64url');
    const authUrl = buildAuthUrl(state);

    logger.info('auth-start', 'Redirecting to Bling OAuth consent screen');
    res.redirect(302, authUrl);
  } catch (err) {
    logger.error('auth-start', 'Failed to build auth URL', { error: String(err) });
    res.status(500).json({ erro: 'Falha ao iniciar OAuth', detalhes: String(err) });
  }
}
