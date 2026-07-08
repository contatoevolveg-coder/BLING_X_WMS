import { fetchWithRetry } from './fetchWithRetry';

const COLORS = { info: 0x3b82f6, warn: 0xf59e0b, error: 0xef4444 };

export async function sendAlert(
  title: string,
  message: string,
  level: 'info' | 'warn' | 'error' = 'error'
): Promise<void> {
  const url = process.env['ALERT_WEBHOOK_URL'];
  if (!url) return;

  const body = {
    embeds: [
      {
        title,
        description: message.slice(0, 2000),
        color: COLORS[level],
        timestamp: new Date().toISOString(),
        footer: { text: 'SyncStock · WMS → Bling' },
      },
    ],
  };

  // Timeout curto (5s) e sem retry: um webhook de alerta lento/pendurado não pode
  // atrasar o processamento do evento que o disparou. Erros são silenciados de
  // propósito — alerta é best-effort, nunca deve derrubar o fluxo principal.
  await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    1,
    5_000
  ).catch(() => {});
}
