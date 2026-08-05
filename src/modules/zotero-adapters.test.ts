import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mapped, Snapshot } from "./fill-policy";
import { computeChanges } from "./fill-policy";
import { fillItem } from "./fill";
import {
  creatorsFromJson,
  creatorsToJson,
  wrapItem,
  type InternalCreator,
  type WrappedCreator,
} from "./zotero-adapters";

// Stub of the installed Zotero creator surface used at runtime:
//   - Zotero.Creators.internalToJSON (creators.js:255-266)
//   - Zotero.Creators.cleanData (creators.js:186-252), the JSON->internal
//     converter that Zotero.Item.prototype.setCreator (item.js:1395-1443)
//     runs every creator entry through; it resolves creatorType via
//     Zotero.CreatorTypes.getID (bound method call on the real instance).
//   - Zotero.CreatorTypes (cachedTypes.js:218-338) with a `_types` cache and
//     getID/getName. IMPORTANT: getID reads `this._types` (cachedTypes.js:99,
//     110), so an UNBOUND call (no `this`) takes the "not loaded" branch and
//     throws "Argument must be a string" -- the exact Defect E mechanism
//     observed live (utilities.js:1137-1141 capitalize + cachedTypes.js:101).
const creatorTypeNames: Record<number, string> = {
  1: "author",
  2: "editor",
  3: "contributor",
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
    // Mirrors the VALIDATED behavior of creators.js:186-252: accepts API
    // JSON format ({creatorType, firstName, lastName} / {creatorType, name})
    // and returns the internal shape {fieldMode, firstName, lastName,
    // creatorTypeID}, resolving the type id via the bound CreatorTypes.getID.
    cleanData(
      data: Record<string, unknown>,
      options: { strict?: boolean } = {},
    ): InternalCreator {
      if (
        data.name === undefined &&
        (data.lastName as string | undefined) === undefined
      ) {
        throw new Error(
          "Creator data must contain either 'name' or 'firstName'/'lastName' properties",
        );
      }
      if (
        data.name !== undefined &&
        (data.firstName !== undefined || data.lastName !== undefined)
      ) {
        throw new Error(
          "Creator data cannot contain both 'name' and 'firstName'/'lastName' properties",
        );
      }
      if (data.name !== undefined && data.fieldMode === 0) {
        throw new Error("'fieldMode' cannot be 0 with 'name' property");
      }
      if (
        data.fieldMode === 1 &&
        data.firstName !== undefined &&
        data.firstName !== "" &&
        data.firstName !== null
      ) {
        throw new Error("'fieldMode' cannot be 1 with 'firstName' property");
      }
      const cleaned: InternalCreator = {
        fieldMode: 0,
        firstName: "",
        lastName: "",
        creatorTypeID: 1,
      };
      if (
        data.firstName !== undefined &&
        data.firstName !== null
      ) {
        cleaned.firstName = String(data.firstName);
      }
      if (data.lastName !== undefined && data.lastName !== null) {
        cleaned.lastName = String(data.lastName);
      }
      if (data.fieldMode) {
        cleaned.fieldMode = (parseInt(String(data.fieldMode), 10) as 0 | 1) || 0;
      }
      if (data.name !== undefined) {
        cleaned.lastName = String(data.name);
        cleaned.fieldMode = 1;
      }
      const creatorType = data.creatorType ?? data.creatorTypeID;
      if (creatorType) {
        const id = (globalThis as any).Zotero.CreatorTypes.getID(creatorType);
        if (id) {
          cleaned.creatorTypeID = id;
        } else if (options.strict) {
          throw new Error(`Unknown creator type '${creatorType}'`);
        }
      }
      return cleaned;
    },
  },
  CreatorTypes: {
    // Same cache layout as cachedTypes.js _cacheTypeData ('_'+id and
    // '_'+name keys; cachedTypes.js:199-214).
    _types: {
      _1: { id: 1, name: "author" },
      _2: { id: 2, name: "editor" },
      _3: { id: 3, name: "contributor" },
      _author: { id: 1, name: "author" },
      _editor: { id: 2, name: "editor" },
      _contributor: { id: 3, name: "contributor" },
    },
    getID(idOrName: string | number): number | false {
      // Mirrors cachedTypes.js:98-116: reads this._types. An UNBOUND call
      // (this is undefined in the strict-mode test module) must throw the
      // same "Argument must be a string" the real unbound call produced via
      // utilities.js:1137-1141 capitalize(this._typeDesc).
      const types = (this as any)?._types;
      if (!types) {
        throw new Error("Argument must be a string");
      }
      const entry = types["_" + idOrName];
      return entry ? entry.id : false;
    },
    getName(idOrName: string | number): string {
      const types = (this as any)?._types;
      if (!types) {
        throw new Error("Argument must be a string");
      }
      const entry = types["_" + idOrName];
      return entry ? entry.name : "";
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// Stub item whose setCreators behaves like the REAL Zotero.Item:
// setCreators (item.js:1446-1461) -> setCreator (item.js:1395-1443) ->
// Zotero.Creators.cleanData (creators.js:186-252), throwing if no
// creatorTypeID survives cleanData (item.js:1406-1408). getCreators returns
// the stored INTERNAL format.
function rawItem(creators: InternalCreator[]) {
  const received: InternalCreator[][] = [];
  const internal = creators.map((c) => ({ ...c }));
  return {
    key: "ABC123",
    itemType: "journalArticle",
    getField: () => undefined,
    setField: () => {},
    getCreators: () => internal.map((c) => ({ ...c })),
    setCreators: (cs: WrappedCreator[]) => {
      const z = (globalThis as any).Zotero;
      const cleaned = cs.map((c) =>
        z && typeof z.Creators?.cleanData === "function"
          ? z.Creators.cleanData(c)
          : ({ ...c } as unknown as InternalCreator),
      );
      received.push(cleaned.map((c) => ({ ...c })));
      internal.length = 0;
      internal.push(...cleaned);
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

describe("creatorsFromJson (JSON -> setCreators passthrough)", () => {
  it("passes JSON-style creators through unchanged; the real item converts via cleanData", () => {
    // Defect E fix: the verified setCreators contract (item.js:1446-1461)
    // accepts "internal or API JSON format" and converts through
    // Zotero.Creators.cleanData (creators.js:186-252), so no hand-rolled
    // JSON->internal mapping happens here anymore (the old one called
    // Zotero.CreatorTypes.getID unbound and threw "Argument must be a
    // string").
    const json = [
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      { creatorType: "editor", name: "Some Org" },
    ];
    expect(creatorsFromJson(json)).toEqual(json);
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

  it("setCreators delegates JSON-style creators unchanged; the receiving item converts (cleanData contract)", () => {
    vi.stubGlobal("Zotero", zoteroStub);
    const raw = rawItem([]);
    const wrapped = wrapItem(raw);

    wrapped.setCreators([
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      { creatorType: "editor", name: "Some Org" },
    ]);

    // The wrapper passes the JSON-style creators through; the item-side
    // cleanData (mimicking creators.js:186-252) stores the internal shape.
    expect(raw.receivedSetCreators()).toEqual([
      [
        { creatorTypeID: 1, fieldMode: 0, firstName: "Jane", lastName: "Doe" },
        {
          creatorTypeID: 2,
          fieldMode: 1,
          firstName: "",
          lastName: "Some Org",
        },
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

describe("Defect E regression: full wrapItem -> fillItem creators write", () => {
  // The stub item.setCreators validates the SAME contract the real
  // Zotero.Item.setCreators enforces (item.js:1395-1461 +
  // creators.js:186-252): every entry passes cleanData; a creatorTypeID must
  // survive; name-only creators become fieldMode 1.
  function realishItem() {
    const fields: Record<string, string> = {};
    const internal: InternalCreator[] = [];
    return {
      key: "E1",
      itemType: "journalArticle",
      getField: (f: string) => fields[f],
      setField: (f: string, v: string) => {
        fields[f] = v;
      },
      getCreators: () => internal.map((c) => ({ ...c })),
      setCreators: (data: WrappedCreator[]) => {
        while (internal.length > data.length) {
          internal.pop();
        }
        for (let i = 0; i < data.length; i++) {
          const cleaned = (globalThis as any).Zotero.Creators.cleanData(data[i]);
          if (cleaned.creatorTypeID === undefined) {
            throw new Error(
              "Creator data must include a valid 'creatorType' or 'creatorTypeID' property",
            );
          }
          internal[i] = cleaned;
        }
      },
      setType: () => {},
      saveTx: async () => {},
    };
  }

  it("writes name-only (consortium) and person creators through the verified contract", async () => {
    vi.stubGlobal("Zotero", zoteroStub);
    const raw = realishItem();
    raw.setField("DOI", "10.1000/consortium");
    const wrapped = wrapItem(raw);
    const fetchCsl = vi.fn(
      async (): Promise<{ ok: true; csl: any }> => ({
        ok: true,
        csl: {
          type: "journal-article",
          title: "A Consortium Paper",
          "container-title": "Test Journal",
          author: [
            { literal: "GTEx Consortium" },
            { given: "Jane", family: "Doe" },
          ],
        },
      }),
    );

    const result = await fillItem(wrapped, { fetchCsl });

    // Before the Defect E fix, creatorsFromJson called
    // Zotero.CreatorTypes.getID unbound: the stub throws
    // "Argument must be a string" (the exact live exception) and fillItem
    // returns status "failed" with reason "apply-error: ...".
    expect(result.status).toBe("filled");
    expect(result.changed).toContain("creators");
    expect(result.reason).toBeUndefined();
    // The item stored the contract-verified internal format: name-only
    // creator as fieldMode 1, person creator as fieldMode 0, both with a
    // numeric creatorTypeID resolved from the creatorType string.
    expect(raw.getCreators()).toEqual([
      {
        creatorTypeID: 1,
        fieldMode: 1,
        firstName: "",
        lastName: "GTEx Consortium",
      },
      { creatorTypeID: 1, fieldMode: 0, firstName: "Jane", lastName: "Doe" },
    ]);
    expect(fetchCsl).toHaveBeenCalledWith("10.1000/consortium");
  });

  it("a creators write violating cleanData still surfaces as apply-error (contract preserved)", async () => {
    vi.stubGlobal("Zotero", zoteroStub);
    const raw = realishItem();
    raw.setField("DOI", "10.1000/badcreators");
    const wrapped = wrapItem(raw);
    // Bypass the policy: exercise the adapter contract directly. A name
    // combined with lastName must be rejected by cleanData
    // (creators.js:191-193), exactly as the real item rejects it.
    expect(() =>
      wrapped.setCreators([
        { creatorType: "author", name: "Org", lastName: "ShouldNotMix" },
      ]),
    ).toThrow("cannot contain both 'name' and 'firstName'/'lastName'");
  });
});
