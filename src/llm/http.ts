import { ProviderError } from './types.js';

export type FetchLike = typeof fetch;

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** fetch with timeout + retry on 429/5xx/network errors (exponential backoff, honours Retry-After). */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      const body = await res.text().catch(() => '');
      lastError = new ProviderError(`HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
      if (!retryable || attempt === retries) throw lastError;
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : base * 2 ** attempt;
      await sleep(delay);
    } catch (err) {
      if (err instanceof ProviderError && (err.status === undefined || !(err.status === 429 || err.status >= 500))) throw err;
      lastError = err;
      if (attempt === retries) break;
      if (!(err instanceof ProviderError)) await sleep(base * 2 ** attempt); // network error / timeout
    }
  }
  throw lastError instanceof Error ? lastError : new ProviderError(String(lastError));
}

/**
 * Try each model in order. Auth errors (401/403) abort immediately; anything else
 * (404 retired model, 429 quota, 5xx overload, bad output) moves on to the next model.
 */
export async function withModelFallback<T>(models: string[], fn: (model: string, retry: RetryOptions) => Promise<T>, retry: RetryOptions = {}): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    try {
      // With fallbacks available, don't burn long backoffs on one overloaded model.
      return await fn(models[i]!, models.length > 1 ? { ...retry, retries: retry.retries ?? 1 } : retry);
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new ProviderError(String(lastError));
}

export function parseModelList(v: string): string[] {
  return v.split(',').map((m) => m.trim()).filter(Boolean);
}
