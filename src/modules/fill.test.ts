import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fillItem, type FillableItem } from "./fill";

interface StubCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

// Duck-typed stub item: a plain object implementing FillableItem with an
// in-memory field map. saveTx is an async no-op; setType records the id.
function makeStub(
  init: { fields?: Record<string, string>; creators?: StubCreator[] } = {},
) {
  const fields: Record<string, string> = { ...(init.fields ?? {}) };
  const creators: StubCreator[] = init.creators
    ? init.creators.map((c) => ({ ...c }))
    : [];
  const setFieldCalls: string[] = [];
  const setCreatorsCalls: StubCreator[][] = [];
  const setTypeIds: number[] = [];
  let saved = 0;

  const item: FillableItem = {
    getField: (field: string) => fields[field],
    setField: (field: string, value: string) => {
      setFieldCalls.push(field);
      fields[field] = value;
    },
    getCreators: () => creators,
    setCreators: (cs) => {
      setCreatorsCalls.push(cs.map((c) => ({ ...c })));
      creators.length = 0;
      creators.push(...cs);
    },
    setType: (typeID: number) => {
      setTypeIds.push(typeID);
    },
    saveTx: async () => {
      saved++;
    },
  };

  return {
    item,
    fields,
    setFieldCalls,
    setCreatorsCalls,
    setTypeIds,
    savedCount: () => saved,
  };
}

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);

function loadFixture(name: string): any {
  return JSON.parse(
    readFileSync(path.join(fixturesDir, `${name}.json`), "utf-8"),
  );
}

const ng3834 = loadFixture("ng3834");

describe("fillItem", () => {
  it("happy path: fills empty fields from CSL and saves", async () => {
    const stub = makeStub({ fields: { DOI: "10.1038/ng.3834" } });
    const fetchCsl = vi.fn(
      async (): Promise<{ ok: true; csl: any }> => ({ ok: true, csl: ng3834 }),
    );
    const result = await fillItem(stub.item, { fetchCsl });

    expect(result.status).toBe("filled");
    expect(result.changed).toContain("title");
    expect(result.changed).toContain("publicationTitle");
    expect(result.changed).toContain("date");
    expect(result.changed).toContain("creators");
    expect(stub.fields.title).toBe(ng3834.title);
    expect(stub.fields.publicationTitle).toBe(ng3834["container-title"]);
    expect(stub.fields.date).toMatch(/^2017/);
    expect(stub.fields.DOI).toBe("10.1038/ng.3834");
    expect(stub.savedCount()).toBe(1);
    expect(fetchCsl).toHaveBeenCalledWith("10.1038/ng.3834");
  });

  it("no DOI -> skipped-no-doi and fetch not called", async () => {
    const stub = makeStub({ fields: { title: "No DOI here" } });
    const fetchCsl = vi.fn();
    const result = await fillItem(stub.item, { fetchCsl });

    expect(result).toEqual({ status: "skipped-no-doi", changed: [] });
    expect(fetchCsl).not.toHaveBeenCalled();
    expect(stub.savedCount()).toBe(0);
  });

  it("fetch failure -> failed with the reported reason", async () => {
    const stub = makeStub({ fields: { DOI: "10.1038/ng.3834" } });
    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({ ok: false, reason: "http-404" }),
    });

    expect(result.status).toBe("failed");
    expect(result.changed).toEqual([]);
    expect(result.reason).toBe("http-404");
    expect(stub.savedCount()).toBe(0);
  });

  it("complete item -> skipped-complete, no writes, no save", async () => {
    const csl = {
      type: "journal-article",
      title: "Existing Title",
      "container-title": "Existing Journal",
      issued: { "date-parts": [[2023, 5, 1]] },
      volume: "1",
      issue: "2",
      page: "10-20",
      ISSN: ["1111-2222"],
      publisher: "Existing Pub",
      URL: "https://example.com/",
      abstract: "Existing abstract.",
      language: "en",
      DOI: "10.1234/complete",
      author: [{ given: "Jane", family: "Doe" }],
    };
    const stub = makeStub({
      fields: {
        DOI: "10.1234/complete",
        extra: "doi: 10.1234/complete",
        itemType: "journalArticle",
        title: "Existing Title",
        publicationTitle: "Existing Journal",
        date: "2023-05-01",
        volume: "1",
        issue: "2",
        pages: "10-20",
        ISSN: "1111-2222",
        publisher: "Existing Pub",
        url: "https://example.com/",
        abstractNote: "Existing abstract.",
        language: "en",
        journalAbbreviation: "",
        proceedingsTitle: "",
        bookTitle: "",
        ISBN: "",
      },
      creators: [
        { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      ],
    });
    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({ ok: true, csl }),
    });

    expect(result).toEqual({ status: "skipped-complete", changed: [] });
    expect(stub.setFieldCalls).toEqual([]);
    expect(stub.setCreatorsCalls).toEqual([]);
    expect(stub.setTypeIds).toEqual([]);
    expect(stub.savedCount()).toBe(0);
  });

  it("creatorsAction set -> setCreators with mapped authors, editor preserved", async () => {
    const stub = makeStub({
      fields: { DOI: "10.1234/authors" },
      creators: [
        { creatorType: "editor", firstName: "Ann", lastName: "Editor" },
      ],
    });
    const csl = {
      type: "journal-article",
      title: "Author paper",
      author: [
        { given: "Jane", family: "Doe" },
        { given: "John", family: "Roe" },
      ],
    };
    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({ ok: true, csl }),
    });

    expect(result.status).toBe("filled");
    expect(result.changed).toContain("creators");
    expect(stub.setCreatorsCalls).toHaveLength(1);
    expect(stub.setCreatorsCalls[0]).toEqual([
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      { creatorType: "author", firstName: "John", lastName: "Roe" },
      { creatorType: "editor", firstName: "Ann", lastName: "Editor" },
    ]);
  });

  it("itemTypeTo -> setType with injected getTypeID value (plain property shape)", async () => {
    const stub = makeStub({ fields: { DOI: "10.1038/ng.3834" } });
    (stub.item as unknown as { itemType: string }).itemType = "webpage";
    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({
        ok: true,
        csl: { type: "journal-article", title: "Web to article" },
      }),
      getTypeID: (name) => (name === "journalArticle" ? 42 : -1),
    });

    expect(result.status).toBe("filled");
    expect(result.changed).toContain("itemType");
    expect(result.changed).toContain("title");
    expect(stub.setTypeIds).toEqual([42]);
    expect(stub.fields.title).toBe("Web to article");
    expect(stub.savedCount()).toBe(1);
  });

  it("fetch throws -> failed with network reason, nothing written", async () => {
    const stub = makeStub({ fields: { DOI: "10.1038/ng.3834" } });
    const result = await fillItem(stub.item, {
      fetchCsl: async () => {
        throw new Error("network down");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.changed).toEqual([]);
    expect(result.reason).toContain("network");
    expect(stub.setFieldCalls).toEqual([]);
    expect(stub.savedCount()).toBe(0);
  });

  it("empty mapped -> skipped-complete, no writes at all", async () => {
    const stub = makeStub({ fields: { DOI: "10.1038/ng.3834" } });
    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({ ok: true, csl: {} }),
    });

    expect(result.status).toBe("skipped-complete");
    expect(result.changed).toEqual([]);
    expect(stub.setFieldCalls).toEqual([]);
    expect(stub.setCreatorsCalls).toEqual([]);
    expect(stub.setTypeIds).toEqual([]);
    expect(stub.savedCount()).toBe(0);
  });

  it("DOI read from extra when the DOI field is missing", async () => {
    const stub = makeStub({
      fields: { extra: "doi: 10.5281/zenodo.21610933" },
    });
    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({
        ok: true,
        csl: { type: "book", title: "Zenodo Deposit" },
      }),
    });

    expect(result.status).toBe("filled");
    expect(result.changed).toContain("title");
    expect(stub.fields.title).toBe("Zenodo Deposit");
    expect(stub.savedCount()).toBe(1);
  });

  it("saveTx throws -> failed with apply-error reason, no rethrow", async () => {
    const stub = makeStub({ fields: { DOI: "10.1038/ng.3834" } });
    (stub.item as any).saveTx = async () => {
      throw new Error("database locked");
    };
    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({ ok: true, csl: ng3834 }),
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("apply-error");
    expect(result.reason).toContain("database locked");
    expect(result.changed).toEqual([]);
  });

  it("B2: a setField that throws skips only that field, fills the rest, saves", async () => {
    const stub = makeStub({ fields: { DOI: "10.1038/ng.3834" } });
    // Simulate Zotero.Item.setField's throw for fields invalid on the
    // current type: "'<field>' is not a valid field for type '<type>'".
    const realSetField = stub.item.setField.bind(stub.item);
    stub.item.setField = (field: string, value: string) => {
      if (field === "publicationTitle") {
        throw new Error("'publicationTitle' is not a valid field for type 'webpage'");
      }
      realSetField(field, value);
    };

    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({ ok: true, csl: ng3834 }),
    });

    expect(result.status).toBe("filled");
    expect(result.changed).toContain("title");
    expect(result.changed).not.toContain("publicationTitle");
    expect(result.skipped).toEqual(["publicationTitle"]);
    expect(stub.fields.title).toBe(ng3834.title);
    expect(stub.fields.publicationTitle).toBeUndefined();
    expect(stub.fields.date).toMatch(/^2017/);
    expect(stub.savedCount()).toBe(1);
  });

  it("B2: itemTypeTo is applied (setType) BEFORE the first setField", async () => {
    const stub = makeStub({ fields: { DOI: "10.1038/ng.3834" } });
    (stub.item as unknown as { itemType: string }).itemType = "webpage";
    const order: string[] = [];
    const realSetField = stub.item.setField.bind(stub.item);
    const realSetType = stub.item.setType.bind(stub.item);
    stub.item.setField = (field: string, value: string) => {
      order.push("setField:" + field);
      realSetField(field, value);
    };
    stub.item.setType = (typeID: number) => {
      order.push("setType:" + typeID);
      realSetType(typeID);
    };

    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({
        ok: true,
        csl: {
          type: "journal-article",
          title: "Web to article",
          "container-title": "Some Journal",
        },
      }),
      getTypeID: (name) => (name === "journalArticle" ? 42 : -1),
    });

    expect(result.status).toBe("filled");
    expect(result.changed).toContain("itemType");
    expect(order[0]).toBe("setType:42");
    const setTypeAt = order.indexOf("setType:42");
    const firstSetFieldAt = order.findIndex((o) => o.startsWith("setField:"));
    expect(setTypeAt).toBeGreaterThanOrEqual(0);
    expect(firstSetFieldAt).toBeGreaterThan(setTypeAt);
    expect(stub.fields.title).toBe("Web to article");
    expect(stub.savedCount()).toBe(1);
  });

  it("B2: setType throwing aborts as apply-error (only setField errors are skippable)", async () => {
    const stub = makeStub({ fields: { DOI: "10.1038/ng.3834" } });
    (stub.item as unknown as { itemType: string }).itemType = "webpage";
    stub.item.setType = () => {
      throw new Error("cannot change type");
    };
    const result = await fillItem(stub.item, {
      fetchCsl: async () => ({
        ok: true,
        csl: { type: "journal-article", title: "Web to article" },
      }),
      getTypeID: () => 42,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("apply-error");
    expect(result.reason).toContain("cannot change type");
    expect(stub.savedCount()).toBe(0);
  });
});
