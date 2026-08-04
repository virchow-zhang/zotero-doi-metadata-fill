import { describe, expect, it, vi } from "vitest";
import type { FillDeps, FillableItem } from "./fill";
import {
  collectLibraryCandidates,
  fillItems,
  needsFill,
  summarizeResults,
  type BatchItem,
  type FillStats,
} from "./batch";

type FetchCsl = (
  doi: string,
) => Promise<{ ok: true; csl: any } | { ok: false; reason: string }>;

interface StubCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

// Duck-typed stub item implementing FillableItem with an in-memory field map
// (same shape as fill.test.ts). saveTx is an async no-op; setType records id.
function makeItem(
  init: { fields?: Record<string, string>; creators?: StubCreator[] } = {},
) {
  const fields: Record<string, string> = { ...(init.fields ?? {}) };
  const creators: StubCreator[] = init.creators
    ? init.creators.map((c) => ({ ...c }))
    : [];
  const saved: number[] = [];
  const item: FillableItem = {
    getField: (field: string) => fields[field],
    setField: (field: string, value: string) => {
      fields[field] = value;
    },
    getCreators: () => creators,
    setCreators: (cs) => {
      creators.length = 0;
      creators.push(...cs.map((c) => ({ ...c })));
    },
    setType: () => {},
    saveTx: async () => {
      saved.push(1);
    },
  };
  return { item, fields, creators, savedCount: () => saved.length };
}

const authors = [{ creatorType: "author", lastName: "Doe" }];
const completeFields = {
  publicationTitle: "Journal of Testing",
  volume: "3",
  pages: "10-20",
};

function batchOf(
  key: string,
  init: { fields?: Record<string, string>; creators?: StubCreator[] } = {},
  doi?: string,
): BatchItem {
  const { item } = makeItem(init);
  return { key, item, doi };
}

function cslOk(title: string): { ok: true; csl: any } {
  return { ok: true, csl: { type: "journal-article", title } };
}

describe("needsFill", () => {
  it("no authors -> true; authors but empty pages -> true; complete -> false", () => {
    expect(
      needsFill({ itemType: "journalArticle", fields: {}, creators: [] }),
    ).toBe(true);
    expect(
      needsFill({
        itemType: "journalArticle",
        fields: { ...completeFields, pages: "" },
        creators: authors,
      }),
    ).toBe(true);
    expect(
      needsFill({
        itemType: "journalArticle",
        fields: completeFields,
        creators: authors,
      }),
    ).toBe(false);
  });

  it("editor-only creators and undefined volume both count as needing fill", () => {
    expect(
      needsFill({
        itemType: "book",
        fields: {},
        creators: [{ creatorType: "editor" }],
      }),
    ).toBe(true);
    expect(
      needsFill({
        itemType: "journalArticle",
        fields: { ...completeFields, volume: undefined as any },
        creators: authors,
      }),
    ).toBe(true);
  });
});

describe("collectLibraryCandidates", () => {
  const okItem = (key: string) =>
    batchOf(
      key,
      { fields: { DOI: "10.1000/x", itemType: "journalArticle" }, creators: authors },
      "10.1000/x",
    );

  it("filters out items without a DOI (field or extra)", async () => {
    const lib = {
      confirm: vi.fn(async () => true),
      getAllItems: vi.fn(async () => [
        okItem("k1"),
        batchOf("k2", { fields: { itemType: "journalArticle" }, creators: authors }),
        batchOf("k3", {
          fields: { extra: "doi: 10.1000/from-extra", itemType: "journalArticle" },
          creators: authors,
        }),
      ]),
    };
    const result = await collectLibraryCandidates(lib);
    expect(result.map((b) => b.key)).toEqual(["k1", "k3"]);
    expect(result[1].doi).toBe("10.1000/from-extra");
  });

  it("filters out items that do not need fill", async () => {
    const lib = {
      confirm: vi.fn(async () => true),
      getAllItems: vi.fn(async () => [
        okItem("k1"),
        batchOf("k2", {
          fields: { DOI: "10.1000/y", itemType: "journalArticle", ...completeFields },
          creators: authors,
        }),
      ]),
    };
    const result = await collectLibraryCandidates(lib);
    expect(result.map((b) => b.key)).toEqual(["k1"]);
  });

  it("keeps items with DOI + missing fields and attaches the extracted doi", async () => {
    const lib = {
      confirm: vi.fn(async () => true),
      getAllItems: vi.fn(async () => [
        batchOf("k1", {
          fields: { DOI: "https://doi.org/10.1000/Alpha.", itemType: "journalArticle" },
          creators: authors,
        }),
      ]),
    };
    const result = await collectLibraryCandidates(lib);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("k1");
    expect(result[0].doi).toBe("10.1000/alpha");
    expect(result[0].item).toBeDefined();
  });

  it("snapshot reads creators via getCreators (missing author triggers fill)", async () => {
    const lib = {
      confirm: vi.fn(async () => true),
      getAllItems: vi.fn(async () => [
        batchOf("k1", {
          fields: { DOI: "10.1000/z", itemType: "journalArticle", ...completeFields },
          creators: [],
        }),
      ]),
    };
    const result = await collectLibraryCandidates(lib);
    expect(result).toHaveLength(1);
  });
});

describe("fillItems", () => {
  it("confirm provided, user declines -> cancelled:true, zero counts, fill never runs", async () => {
    const spyFetch = vi.fn(async () => {
      throw new Error("fetchCsl must not be called");
    });
    const deps: FillDeps = { fetchCsl: spyFetch };
    const items = [
      batchOf(
        "k1",
        { fields: { DOI: "10.1000/a", itemType: "journalArticle" }, creators: authors },
        "10.1000/a",
      ),
      batchOf(
        "k2",
        { fields: { DOI: "10.1000/b", itemType: "journalArticle" }, creators: authors },
        "10.1000/b",
      ),
    ];
    const confirm = vi.fn(async () => false);
    const stats = await fillItems(items, deps, { confirm });
    expect(stats).toEqual({
      filled: 0,
      skippedNoDoi: 0,
      skippedComplete: 0,
      failed: 0,
      failures: [],
      changedFields: new Set(),
      cancelled: true,
    });
    expect(spyFetch).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(
      "将对 2 条候选条目批量补全，确定继续？",
    );
  });

  it("confirm provided, user accepts -> processes only candidates, counts correct", async () => {
    const fetchCsl = vi.fn(async () => cslOk("Filled Title"));
    const deps: FillDeps = { fetchCsl };
    const incomplete = batchOf(
      "k1",
      {
        fields: { DOI: "10.1000/a", itemType: "journalArticle", publicationTitle: "J" },
        creators: authors,
      },
      "10.1000/a",
    );
    const incomplete2 = batchOf(
      "k2",
      {
        fields: { DOI: "10.1000/b", itemType: "journalArticle", pages: "1" },
        creators: authors,
      },
      "10.1000/b",
    );
    const complete = batchOf(
      "k3",
      {
        fields: { DOI: "10.1000/c", itemType: "journalArticle", ...completeFields },
        creators: authors,
      },
      "10.1000/c",
    );
    const confirm = vi.fn(async () => true);
    const stats = await fillItems([incomplete, incomplete2, complete], deps, {
      confirm,
    });

    expect(stats.filled).toBe(2);
    expect(stats.failed).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetchCsl).toHaveBeenCalledTimes(2);
    expect(fetchCsl).not.toHaveBeenCalledWith("10.1000/c");
  });

  it("no confirm -> processes all items; aggregates filled/skipped-no-doi/failed", async () => {
    const fetchCsl = vi.fn<FetchCsl>(async (doi: string) =>
      doi === "10.1000/fail"
        ? { ok: false, reason: "http-404" }
        : cslOk("Filled Title"),
    );
    const deps: FillDeps = { fetchCsl };
    const items = [
      batchOf(
        "k1",
        {
          fields: { DOI: "10.1000/ok", itemType: "journalArticle" },
          creators: authors,
        },
        "10.1000/ok",
      ),
      batchOf("k2", { fields: { itemType: "journalArticle" }, creators: authors }),
      batchOf(
        "k3",
        {
          fields: { DOI: "10.1000/fail", itemType: "journalArticle" },
          creators: authors,
        },
        "10.1000/fail",
      ),
    ];
    const stats = await fillItems(items, deps);

    expect(stats.filled).toBe(1);
    expect(stats.skippedNoDoi).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.failures).toEqual([
      { doi: "10.1000/fail", reason: "http-404" },
    ]);
    expect(stats.changedFields).toEqual(new Set(["title"]));
    expect(stats.cancelled).toBeUndefined();
  });

  it("item that is complete on arrival still processed without confirm -> skipped-complete", async () => {
    const fetchCsl = vi.fn<FetchCsl>(async () => ({
      ok: true,
      csl: {
        type: "journal-article",
        title: "Same Title",
        "container-title": "Journal of Testing",
        volume: "3",
        page: "10-20",
        author: [{ given: "Jane", family: "Doe" }],
      },
    }));
    const complete = batchOf(
      "k1",
      {
        fields: {
          DOI: "10.1000/d",
          itemType: "journalArticle",
          title: "Same Title",
          publicationTitle: "Journal of Testing",
          volume: "3",
          pages: "10-20",
        },
        creators: authors,
      },
      "10.1000/d",
    );
    const stats = await fillItems([complete], { fetchCsl });
    expect(stats.skippedComplete).toBe(1);
    expect(stats.filled).toBe(0);
  });

  it(
    "failures are capped at 20 entries while failed count stays full",
    async () => {
      const fetchCsl = vi.fn<FetchCsl>(async () => ({ ok: false, reason: "http-500" }));
      const items: BatchItem[] = Array.from({ length: 25 }, (_, i) =>
        batchOf(
          `k${i}`,
          {
            fields: { DOI: `10.1000/idx${i}`, itemType: "journalArticle" },
            creators: authors,
          },
          `10.1000/idx${i}`,
        ),
      );
      const stats = await fillItems(items, { fetchCsl });
      expect(stats.failed).toBe(25);
      expect(stats.failures).toHaveLength(20);
      expect(stats.failures[0].doi).toBe("10.1000/idx0");
      expect(stats.failures[19].doi).toBe("10.1000/idx19");
      expect(stats.failures.every((f) => f.reason === "http-500")).toBe(true);
    },
    30000,
  );

  it("candidateCount provided skips the confirm dialog entirely", async () => {
    const fetchCsl = vi.fn(async () => cslOk("T"));
    const confirm = vi.fn(async () => {
      throw new Error("confirm must not be called");
    });
    const items = [batchOf("k1", {
      fields: { DOI: "10.1000/e", itemType: "journalArticle" },
      creators: authors,
    }, "10.1000/e")];
    const stats = await fillItems(items, { fetchCsl }, { confirm, candidateCount: 1 });
    expect(stats.filled).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("summarizeResults", () => {
  const base: FillStats = {
    filled: 3,
    skippedNoDoi: 1,
    skippedComplete: 2,
    failed: 4,
    failures: [{ doi: "10.1000/x", reason: "http-404" }],
    changedFields: new Set(["title"]),
  };

  it("formats the counts line", () => {
    expect(summarizeResults(base)).toBe(
      "补全成功 3 / 跳过-无DOI 1 / 跳过-已完整 2 / 失败 4",
    );
  });

  it("cancelled variant appends 已取消", () => {
    expect(summarizeResults({ ...base, cancelled: true })).toBe(
      "补全成功 3 / 跳过-无DOI 1 / 跳过-已完整 2 / 失败 4（已取消）",
    );
  });
});
