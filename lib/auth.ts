import crypto from 'crypto';
import type { VercelRequest } from '@vercel/node';

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(';').flatMap((c) => {
      const [k, ...rest] = c.trim().split('=');
      return k ? [[k, decodeURIComponent(rest.join('='))]] : [];
    })
  );
}

export function cookieToken(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function isDashAuthenticated(req: VercelRequest): boolean {
  const secret = process.env['DASHBOARD_SECRET'];
  if (!secret) return true;
  const cookies = parseCookies(req.headers.cookie ?? '');
  return cookies['dash_auth'] === cookieToken(secret);
}

export function dashCookieHeader(secret: string): string {
  return `dash_auth=${cookieToken(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`;
}
