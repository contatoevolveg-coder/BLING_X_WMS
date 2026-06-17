export async function fetchWithRetry(
  url: string,
  options: any,
  retries = 3
): Promise<any> {
  let lastRes: any | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok && (res.status === 429 || res.status >= 500) && i < retries - 1) {
        lastRes = res;
        const backoffMs = Math.pow(2, i) * 500;
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      return res;
    } catch (err) {
      if (i < retries - 1) {
        const backoffMs = Math.pow(2, i) * 500;
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }
  if (lastRes) return lastRes;
  throw new Error('fetchWithRetry failed unexpectedly');
}
