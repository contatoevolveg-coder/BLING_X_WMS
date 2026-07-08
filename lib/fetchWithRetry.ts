// Teto de tempo por tentativa. O limite da função serverless (Vercel) é 60s;
// com retries=3 e 15s por tentativa o pior caso (45s + backoffs) fica abaixo disso.
// Sem esse teto, uma chamada pendurada ao Bling/WMS consumiria os 60s inteiros e
// deixaria o evento preso em 'processing' (órfão) — a classe de falha que a fila
// tenta justamente evitar.
const DEFAULT_TIMEOUT_MS = 15_000;

function backoffMs(attempt: number): number {
  return Math.pow(2, attempt) * 500; // 500ms, 1s, 2s, ...
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch com retry exponencial e timeout por tentativa.
 * - Repete em HTTP 429 / 5xx e em erros de rede ou timeout.
 * - Cada tentativa é abortada após `timeoutMs` (converte um "pendurado" em erro,
 *   que então respeita a política de retry em vez de travar a função).
 * - Retorna a última Response mesmo em 5xx quando as tentativas se esgotam, para o
 *   chamador decidir o que fazer com o status.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  let lastRes: Response | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });

      const retryable = res.status === 429 || res.status >= 500;
      if (!res.ok && retryable && attempt < retries - 1) {
        lastRes = res;
        await delay(backoffMs(attempt));
        continue;
      }
      return res;
    } catch (err) {
      // AbortError (timeout) e falhas de rede caem aqui.
      if (attempt < retries - 1) {
        await delay(backoffMs(attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastRes) return lastRes;
  throw new Error('fetchWithRetry esgotou as tentativas sem obter resposta');
}
