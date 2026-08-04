import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mapped, Snapshot } from "./fill-policy";
import { computeChanges } from "./fill-policy";
import {
  creatorsFromJson,
  creatorsToJson,
  wrapItem,
  type InternalCreator,
  type WrappedCreator,
} from "./zotero-adapters";

// Stub of the installed Zotero creator surface used at runtime:
//   - Zotero.Creators.internalToJSON (creators.js:255-266)
//   - Zotero.CreatorTypes.getID (cachedTypes.js:98-116, keys '_'+id and '_'+name)
const creatorTypeNames: Record<number, string> = {
  1: "author",
  2: "editor",
  3: "contributor",
};
const creatorTypeIDs: Record<string, number> = {
  author: 1,
  editor: 2,
  contributor: 3,
};

const zoteroStub = {
  Creators: {
    internalToJSON(fields: {
      creatorTypeID: number;
      fieldMode: number;
      firstName?: string;
      lastName?: string;
    }): WrappedCreator {
      const out: WrappedCreator = {
        creatorType: creatorTypeNames[fields.creatorTypeID] ?? "author",
      };
      if (fields.fieldMode === 1) {
        out.name = fields.lastName ?? "";
      } else {
        out.firstName = fields.firstName ?? "";
        out.lastName = fields.lastName ?? "";
      }
      return out;
    },
  },
  CreatorTypes: {
    getID(idOrName: string | number): number | false {
      if (typeof idOrName === "number") {
        return creatorTypeNames[idOrName] !== undefined ? idOrName : false;
      }
      return creatorTypeIDs[idOrName] ?? false;
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function rawItem(creators: InternalCreator[]) {
  const received: InternalCreator[][] = [];
  return {
    key: "ABC123",
    itemType: "journalArticle",
    getField: () => undefined,
    setField: () => {},
    getCreators: () => creators,
    setCreators: (cs: InternalCreator[]) => {
      received.push(cs.map((c) => ({ ...c })));
    },
    setType: () => {},
    saveTx: async () => {},
    receivedSetCreators: () => received,
  };
}

describe("creatorsToJson (internal -> JSON)", () => {
  it("converts creatorTypeID/fieldMode to creatorType strings (both field modes)", () => {
    vi.stubGlobal("Zotero", zoteroStub);
    const json = creatorsToJson([
      { creatorTypeID: 1, fieldMode: 0, firstName: "Jane", lastName: "Doe" },
      { creatorTypeID: 2, fieldMode: 1, lastName: "World Health Organization" },
    ]);
    expect(json).toEqual([
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      { creatorType: "editor", name: "World Health Organization" },
    ]);
  });

  it("falls back to a manual mapping when Zotero is unavailable", () => {
    const json = creatorsToJson([
      { creatorTypeID: 1, fieldMode: 0, firstName: "Jane", lastName: "Doe" },
    ]);
    expect(json).toEqual([
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
    ]);
  });
});

describe("creatorsFromJson (JSON -> internal)", () => {
  it("maps name and firstName/lastName creators with fieldMode and creatorTypeID", () => {
    vi.stubGlobal("Zotero", zoteroStub);
    const internal = creatorsFromJson([
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      { creatorType: "editor", name: "Some Org" },
    ]);
    expect(internal).toEqual([
      { creatorTypeID: 1, firstName: "Jane", lastName: "Doe", fieldMode: 0 },
      { creatorTypeID: 2, name: "Some Org", fieldMode: 1 },
    ]);
  });
});

describe("wrapItem", () => {
  it("getCreators translates internal creators so the policy sees an author (B1 regression)", () => {
    vi.stubGlobal("Zotero", zoteroStub);
    // A real Zotero item returns INTERNAL creator data: no creatorType string.
    const wrapped = wrapItem(
      rawItem([
        { creatorTypeID: 1, fieldMode: 0, firstName: "John", lastName: "Smith" },
      ]),
    );

    const snapshot: Snapshot = {
      itemType: "journalArticle",
      fields: { publicationTitle: "J", volume: "1", pages: "10-20" },
      creators: wrapped.getCreators(),
    };
    const mapped: Mapped = {
      fields: {},
      creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }],
    };
    const changes = computeChanges(snapshot, mapped);

    expect(wrapped.getCreators()[0].creatorType).toBe("author");
    // Equal-length author lists must NOT force creatorsAction "set"
    // (the B1 bug: internal creators looked like zero authors -> always set).
    expect(changes.creatorsAction).toBe("none");
  });

  it("setCreators converts JSON creators to internal format before delegating", () => {
    vi.stubGlobal("Zotero", zoteroStub);
    const raw = rawItem([]);
    const wrapped = wrapItem(raw);

    wrapped.setCreators([
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      { creatorType: "editor", name: "Some Org" },
    ]);

    expect(raw.receivedSetCreators()).toEqual([
      [
        { creatorTypeID: 1, firstName: "Jane", lastName: "Doe", fieldMode: 0 },
        { creatorTypeID: 2, name: "Some Org", fieldMode: 1 },
      ],
    ]);
  });

  it("delegates fields/type/save and exposes key/itemType without mutating the raw item", async () => {
    vi.stubGlobal("Zotero", zoteroStub);
    const saved: number[] = [];
    const typeIDs: number[] = [];
    const fields: Record<string, string> = { title: "Old" };
    const raw = {
      key: "K1",
      itemType: "webpage",
      getField: (f: string) => fields[f],
      setField: (f: string, v: string) => {
        fields[f] = v;
      },
      getCreators: () => [],
      setCreators: () => {},
      setType: (id: number) => {
        typeIDs.push(id);
      },
      saveTx: async () => {
        saved.push(1);
      },
    };
    const wrapped = wrapItem(raw);

    expect(wrapped.key).toBe("K1");
    expect(wrapped.itemType).toBe("webpage");
    wrapped.setField("title", "New");
    wrapped.setType(42);
    await wrapped.saveTx();

    expect(fields.title).toBe("New");
    expect(typeIDs).toEqual([42]);
    expect(saved).toEqual([1]);
    expect(Object.keys(raw)).toEqual([
      "key",
      "itemType",
      "getField",
      "setField",
      "getCreators",
      "setCreators",
      "setType",
      "saveTx",
    ]);
  });
});
