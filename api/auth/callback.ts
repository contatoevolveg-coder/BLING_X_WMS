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
    logger.error('auth-callback', 'Bling retornou erro OAuth', {
      error: String(error),
      description: String(error_description ?? ''),
    });
    res.status(400).json({
      sucesso: false,
      erro: String(error),
      descricao: String(error_description ?? ''),
    });
    return;
  }

  const authCode = Array.isArray(code) ? code[0] : code;

  if (!authCode) {
    res.status(400).json({ sucesso: false, erro: 'Código de autorização ausente' });
    return;
  }

  try {
    await exchangeCodeForTokens(authCode);
    
    // Delete the state cookie after successful auth
    res.setHeader('Set-Cookie', 'bling_oauth_state=; Path=/; HttpOnly; Max-Age=0');

    res.status(200).json({
      sucesso: true,
      mensagem: 'Autenticação com o Bling realizada com sucesso! Tokens salvos.',
    });
  } catch (err) {
    logger.error('oauth', 'Erro no callback OAuth', { error: String(err) });
    res.status(500).json({ sucesso: false, erro: String(err) });
  }
}
