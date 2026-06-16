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
