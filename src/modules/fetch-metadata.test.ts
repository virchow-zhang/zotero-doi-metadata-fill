import { describe, expect, it, vi } from "vitest";
import {
  fetchCslByDoi,
  runPool,
  type FetchCslResult,
  type HttpGet,
} from "./fetch-metadata";

interface HttpCall {
  url: string;
  opts: {
    headers: Record<string, string>;
    responseType: string;
    timeout: number;
  };
}

function mockHttp(
  handler: (
    url: string,
    opts: HttpCall["opts"],
  ) => Promise<{ status: number; json?: any; text?: string }> | {
    status: number;
    json?: any;
    text?: string;
  },
): { http: HttpGet; calls: HttpCall[] } {
  const calls: HttpCall[] = [];
  const fn = vi.fn(async (url: string, opts: HttpCall["opts"]) => {
    calls.push({ url, opts });
    return handler(url, opts);
  });
  return { http: fn as unknown as HttpGet, calls };
}

const CSL = { title: "Test Paper", DOI: "10.1234/example", type: "article-journal" };

describe("fetchCslByDoi", () => {
  it("returns csl on 200 with json object", async () => {
    const { http, calls } = mockHttp(async () => ({ status: 200, json: CSL }));
    const res = await fetchCslByDoi("10.1234/example", http, { retryDelayMs: 0 });
    expect(res).toEqual({ ok: true, csl: CSL });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://doi.org/10.1234%2Fexample");
    expect(calls[0].opts.headers).toEqual({
      Accept: "application/vnd.citationstyles.csl+json",
      "User-Agent": "ZoteroPlugin-DOIMetadataFill/0.1",
    });
    expect(calls[0].opts.responseType).toBe("json");
    expect(calls[0].opts.timeout).toBe(15000);
  });

  it("returns http-404 on 404", async () => {
    const { http, calls } = mockHttp(async () => ({ status: 404, text: "nope" }));
    const res = await fetchCslByDoi("10.1234/missing", http, { retryDelayMs: 0 });
    expect(res).toEqual({ ok: false, reason: "http-404" });
    expect(calls).toHaveLength(1);
  });

  it("retries once after 429 and succeeds on 200", async () => {
    const statuses = [429, 200];
    const { http, calls } = mockHttp(async () => {
      const status = statuses.shift() ?? 200;
      return status === 200 ? { status, json: CSL } : { status, text: "slow down" };
    });
    const res = await fetchCslByDoi("10.1234/example", http, { retryDelayMs: 0 });
    expect(res).toEqual({ ok: true, csl: CSL });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(calls[1].url);
    expect(calls[0].opts).toEqual(calls[1].opts);
  });

  it("returns server-error when 500 twice", async () => {
    const { http, calls } = mockHttp(async () => ({ status: 500, text: "boom" }));
    const res = await fetchCslByDoi("10.1234/example", http, { retryDelayMs: 0 });
    expect(res).toEqual({ ok: false, reason: "server-error" });
    expect(calls).toHaveLength(2);
  });

  it("returns network-error when http throws twice", async () => {
    const { http, calls } = mockHttp(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await fetchCslByDoi("10.1234/example", http, { retryDelayMs: 0 });
    expect(res).toEqual({ ok: false, reason: "network-error" });
    expect(calls).toHaveLength(2);
  });

  it("R3: status 0 (timeout/network) is retried and succeeds on the retry", async () => {
    const statuses = [0, 200];
    const { http, calls } = mockHttp(async () => {
      const status = statuses.shift() ?? 200;
      return status === 200 ? { status, json: CSL } : { status, text: "" };
    });
    const res = await fetchCslByDoi("10.1234/example", http, { retryDelayMs: 0 });
    expect(res).toEqual({ ok: true, csl: CSL });
    expect(calls).toHaveLength(2);
  });

  it("R3: status 0 twice -> network-error (not server-error)", async () => {
    const { http, calls } = mockHttp(async () => ({ status: 0, text: "" }));
    const res = await fetchCslByDoi("10.1234/example", http, { retryDelayMs: 0 });
    expect(res).toEqual({ ok: false, reason: "network-error" });
    expect(calls).toHaveLength(2);
  });

  it("returns invalid-json for unparseable text on 200", async () => {
    const { http } = mockHttp(async () => ({ status: 200, text: "{not json" }));
    const res = await fetchCslByDoi("10.1234/example", http, { retryDelayMs: 0 });
    expect(res).toEqual({ ok: false, reason: "invalid-json" });
  });

  it("parses valid JSON text on 200", async () => {
    const { http } = mockHttp(async () => ({
      status: 200,
      json: null,
      text: JSON.stringify(CSL),
    }));
    const res = await fetchCslByDoi("10.1234/example", http, { retryDelayMs: 0 });
    expect(res).toEqual({ ok: true, csl: CSL });
  });

  it("returns invalid-json for a JSON array on 200", async () => {
    const { http } = mockHttp(async () => ({ status: 200, json: [CSL] }));
    const res: FetchCslResult = await fetchCslByDoi("10.1234/example", http, {
      retryDelayMs: 0,
    });
    expect(res).toEqual({ ok: false, reason: "invalid-json" });
  });
});

describe("runPool", () => {
  it("caps in-flight workers at concurrency and preserves order", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await runPool(
      items,
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return n * 10;
      },
      { concurrency: 3, minIntervalMs: 0 },
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(results.map((r) => r.item)).toEqual(items);
    expect(results.map((r) => r.result)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("skips rejected items and keeps remaining results in order", async () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const results = await runPool(
      items,
      async (s) => {
        if (s === "b" || s === "e") throw new Error("boom");
        return s.toUpperCase();
      },
      { concurrency: 2, minIntervalMs: 0 },
    );
    expect(results.map((r) => r.item)).toEqual(["a", "c", "d", "f"]);
    expect(results.map((r) => r.result)).toEqual(["A", "C", "D", "F"]);
  });

  it("R1: logs worker rejections with the item index", async () => {
    const logs: string[] = [];
    const results = await runPool(
      ["a", "b", "c"],
      async (s) => {
        if (s === "c") throw new Error("boom");
        return s;
      },
      {
        concurrency: 2,
        minIntervalMs: 0,
        log: (l) => logs.push(l),
      },
    );
    expect(results.map((r) => r.item)).toEqual(["a", "b"]);
    expect(logs.some((l) => l === "runPool worker rejected for item 2: Error: boom")).toBe(
      true,
    );
  });

  it("enforces minIntervalMs between consecutive starts", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    const starts: number[] = [];
    await runPool(
      items,
      async (n) => {
        starts.push(Date.now());
        return n;
      },
      { concurrency: 3, minIntervalMs: 50 },
    );
    expect(starts).toHaveLength(6);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(45);
    }
  });
});
