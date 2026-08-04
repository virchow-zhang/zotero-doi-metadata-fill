export type HttpGet = (
  url: string,
  opts: {
    headers: Record<string, string>;
    responseType: 'json';
    timeout: number;
  },
) => Promise<{ status: number; json?: any; text?: string }>;

export type FetchCslResult =
  | { ok: true; csl: any }
  | { ok: false; reason: string };

export interface FetchCslDeps {
  retryDelayMs?: number;
  log?: (s: string) => void;
}

export interface RunPoolOpts {
  concurrency?: number;
  minIntervalMs?: number;
  log?: (s: string) => void;
}

export interface PoolEntry<T, R> {
  item: T;
  result: R;
}

const DOI_BASE_URL = 'https://doi.org/';
const ACCEPT_HEADER = 'application/vnd.citationstyles.csl+json';
const USER_AGENT = 'ZoteroPlugin-DOIMetadataFill/0.1';
const REQUEST_TIMEOUT = 15000;
const DEFAULT_RETRY_DELAY_MS = 2000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MIN_INTERVAL_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCslObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetryableStatus(status: number): boolean {
  // status 0 = network failure / timeout as resolved by Zotero.HTTP with
  // successCodes: false (no HTTP status line ever received); treat as
  // retryable, and classify as network-error after retry exhaustion.
  return status === 0 || status === 429 || status >= 500;
}

export async function fetchCslByDoi(
  doi: string,
  http: HttpGet,
  deps?: FetchCslDeps,
): Promise<FetchCslResult> {
  const retryDelayMs = deps?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const log = deps?.log ?? (() => {});
  const url = `${DOI_BASE_URL}${encodeURIComponent(doi)}`;
  const opts = {
    headers: {
      Accept: ACCEPT_HEADER,
      'User-Agent': USER_AGENT,
    },
    responseType: 'json' as const,
    timeout: REQUEST_TIMEOUT,
  };

  async function attempt(): Promise<
    { status: number; json?: any; text?: string } | undefined
  > {
    try {
      return await http(url, opts);
    } catch (err) {
      log(`fetchCslByDoi: network error for ${url}: ${String(err)}`);
      return undefined;
    }
  }

  let res = await attempt();
  if (res === undefined || isRetryableStatus(res.status)) {
    log(`fetchCslByDoi: retrying ${url} in ${retryDelayMs}ms`);
    await sleep(retryDelayMs);
    res = await attempt();
    if (res === undefined) {
      return { ok: false, reason: 'network-error' };
    }
    if (isRetryableStatus(res.status)) {
      return res.status === 0
        ? { ok: false, reason: 'network-error' }
        : { ok: false, reason: 'server-error' };
    }
  }

  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: `http-${res.status}` };
  }

  if (res.json !== undefined && res.json !== null) {
    if (isCslObject(res.json)) {
      return { ok: true, csl: res.json };
    }
    return { ok: false, reason: 'invalid-json' };
  }

  if (typeof res.text === 'string' && res.text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(res.text);
      if (isCslObject(parsed)) {
        return { ok: true, csl: parsed };
      }
      return { ok: false, reason: 'invalid-json' };
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
  }

  return { ok: false, reason: 'invalid-json' };
}

export async function runPool<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  opts?: RunPoolOpts,
): Promise<PoolEntry<T, R>[]> {
  const concurrency = Math.max(1, opts?.concurrency ?? DEFAULT_CONCURRENCY);
  const minIntervalMs = Math.max(0, opts?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  const log = opts?.log ?? (() => {});

  const resolved: Array<{ idx: number; item: T; result: R }> = [];
  const skippedIndices: number[] = [];

  let nextIdx = 0;
  let active = 0;
  let lastStart = 0;
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => (settle = resolve));

  function pump(): void {
    if (nextIdx >= items.length && active === 0) {
      settle();
      return;
    }
    while (nextIdx < items.length && active < concurrency) {
      const now = Date.now();
      const earliestStart = lastStart + minIntervalMs;
      if (now < earliestStart) {
        setTimeout(pump, earliestStart - now);
        return;
      }
      const idx = nextIdx++;
      const item = items[idx];
      lastStart = now;
      active++;
      worker(item)
        .then(
          (result) => resolved.push({ idx, item, result }),
          (err) => {
            log(`runPool worker rejected for item ${idx}: ${String(err)}`);
            skippedIndices.push(idx);
          },
        )
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  pump();
  await settled;
  resolved.sort((a, b) => a.idx - b.idx);
  return resolved.map(({ item, result }) => ({ item, result }));
}
