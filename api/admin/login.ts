import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cookieToken, dashCookieHeader } from '../../lib/auth';

const LOGIN_HTML = (next: string, error = '') => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SyncStock — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:36px 40px;width:100%;max-width:380px}
.logo{font-size:1.2rem;font-weight:700;color:#f8fafc;margin-bottom:6px}
.logo span{color:#f59e0b}
.sub{font-size:.8rem;color:#64748b;margin-bottom:28px}
label{font-size:.72rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px}
input{width:100%;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;padding:10px 14px;font-size:.9rem;outline:none;margin-bottom:16px}
input:focus{border-color:#3b82f6}
button{width:100%;background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:11px;font-size:.9rem;font-weight:600;cursor:pointer}
button:hover{background:#2563eb}
.err{background:#7f1d1d;color:#fca5a5;border-radius:6px;padding:10px 14px;font-size:.8rem;margin-bottom:16px}
</style>
</head>
<body>
<div class="box">
  <div class="logo"><span>⚡</span> SyncStock</div>
  <div class="sub">Dashboard · Acesso Restrito</div>
  ${error ? `<div class="err">${error}</div>` : ''}
  <form method="POST" action="/api/admin/login">
    <input type="hidden" name="next" value="${next}">
    <label>Senha</label>
    <input type="password" name="password" autofocus placeholder="••••••••">
    <button type="submit">Entrar</button>
  </form>
</div>
</body>
</html>`;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const secret = process.env['DASHBOARD_SECRET'];

  if (!secret) {
    res.redirect(302, '/api/status');
    return;
  }

  const next = String((req.query['next'] as string) ?? '/api/status');

  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(LOGIN_HTML(next));
    return;
  }

  if (req.method === 'POST') {
    const body = req.body as Record<string, string> | undefined;
    const password = body?.['password'] ?? '';
    const postNext = body?.['next'] ?? '/api/status';

    if (cookieToken(password) === cookieToken(secret)) {
      res.setHeader('Set-Cookie', dashCookieHeader(secret));
      res.redirect(302, postNext);
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(401).send(LOGIN_HTML(postNext, 'Senha incorreta.'));
    }
    return;
  }

  res.status(405).end();
}
