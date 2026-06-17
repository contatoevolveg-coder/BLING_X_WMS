type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  level: LogLevel;
  source: string;
  message: string;
  timestamp: string;
  event_id?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

function emit(
  level: LogLevel,
  source: string,
  message: string,
  extra?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    level,
    source,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  // Vercel captures stdout as structured logs; stderr for errors.
  const out = JSON.stringify(entry);
  if (level === 'error') {
    console.error(out);
  } else {
    console.log(out);
  }

  // Dispara alerta (ex: Discord/Slack) se o nível for warn ou error e o Webhook existir
  if (level === 'warn' || level === 'error') {
    void sendAlertWebhook(entry);
  }
}

async function sendAlertWebhook(entry: LogEntry): Promise<void> {
  const webhookUrl = process.env['ALERT_WEBHOOK_URL'];
  if (!webhookUrl) return;

  const color = entry.level === 'error' ? 16711680 : 16776960; // Red for error, Yellow for warn
  const payload = {
    content: `🚨 **SyncStock Alert [${entry.level.toUpperCase()}]**`,
    embeds: [
      {
        title: entry.message,
        description: `**Source**: ${entry.source}\n**Time**: ${entry.timestamp}`,
        color: color,
        fields: Object.entries(entry)
          .filter(([k]) => !['level', 'source', 'message', 'timestamp'].includes(k))
          .map(([k, v]) => ({ name: k, value: String(v), inline: true })),
      },
    ],
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      source: 'logger',
      message: 'Failed to dispatch alert webhook',
      error: String(err)
    }));
  }
}

export const logger = {
  info: (source: string, message: string, extra?: Record<string, unknown>) =>
    emit('info', source, message, extra),

  warn: (source: string, message: string, extra?: Record<string, unknown>) =>
    emit('warn', source, message, extra),

  error: (source: string, message: string, extra?: Record<string, unknown>) =>
    emit('error', source, message, extra),

  debug: (source: string, message: string, extra?: Record<string, unknown>) =>
    emit('debug', source, message, extra),
};
