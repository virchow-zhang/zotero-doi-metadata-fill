// Applies policy-approved changes to a Zotero item.
//
// This module NEVER imports the Zotero runtime. The caller passes an
// item-like object (a real ZoteroItem in the plugin, a plain stub in tests)
// that satisfies `FillableItem`; the Zotero global is bound only in the
// plugin entry (a later todo).
import type { ItemSnapshot } from "./doi";
import { extractDoi } from "./doi";
import type { MappedCreator } from "./csl-map";
import { mapCslToZotero } from "./csl-map";
import type { Snapshot } from "./fill-policy";
import { computeChanges } from "./fill-policy";
import {
  fetchCslByDoi,
  type FetchCslResult,
  type HttpGet,
} from "./fetch-metadata";

export type FillStatus =
  | "filled"
  | "skipped-no-doi"
  | "skipped-complete"
  | "failed";

export interface FillResult {
  status: FillStatus;
  changed: string[];
  reason?: string;
  // Fields whose setField threw (e.g. a field invalid for the target item
  // type before setType took effect); the field was skipped, the fill
  // continued, and saveTx still ran.
  skipped?: string[];
}

// The Zotero Item surface this module requires (duck type; runtime object is
// a real Zotero item). getField("itemType") is NOT supported by real Zotero
// items; see readItemType for the two supported shapes.
export interface FillableItem {
  getField(field: string): string | undefined;
  setField(field: string, value: string): void;
  getCreators(): Array<{
    creatorType: string;
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
  setCreators(
    creators: Array<{
      creatorType: string;
      firstName?: string;
      lastName?: string;
      name?: string;
    }>,
  ): void;
  setType(typeID: number): void;
  saveTx(): Promise<void>;
}

export interface FillDeps {
  fetchCsl?: (
    doi: string,
  ) => Promise<{ ok: true; csl: any } | { ok: false; reason: string }>;
  // Defaults to `(name) => 1` (identity by name table is a plugin-entry
  // concern); callers inject a real type-mapping function.
  getTypeID?: (typeName: string) => number;
}

const SNAPSHOT_FIELDS = [
  "DOI",
  "extra",
  "title",
  "publicationTitle",
  "date",
  "volume",
  "issue",
  "pages",
  "ISSN",
  "publisher",
  "url",
  "abstractNote",
  "language",
  "journalAbbreviation",
  "proceedingsTitle",
  "bookTitle",
  "ISBN",
] as const;

// itemType comes from two supported shapes:
//  1. duck-typed stubs: getField("itemType") returns the type name;
//  2. real Zotero items: getField("itemType") returns undefined, but the
//     item exposes a plain `itemType` property (e.g. "journalArticle").
function readItemType(item: FillableItem): string {
  const viaGetField = (item as any).getField?.("itemType");
  if (typeof viaGetField === "string" && viaGetField !== "") {
    return viaGetField;
  }
  const plain = (item as any).itemType;
  return typeof plain === "string" ? plain : "";
}

// If the caller did not inject deps.fetchCsl, route through the real
// fetchCslByDoi but with a PLACEHOLDER HttpGet that throws: the real Zotero
// HTTP binding lives in the plugin entry (a later todo), which must pass
// deps.fetchCsl. The executor tests always inject deps.fetchCsl, so this
// path only yields `{ ok: false, reason: "network-error" }` here.
const PLACEHOLDER_HTTP: HttpGet = () => {
  throw new Error("no http bound");
};

async function fetchWithDefault(doi: string): Promise<FetchCslResult> {
  return fetchCslByDoi(doi, PLACEHOLDER_HTTP, { retryDelayMs: 0 });
}

export async function fillItem(
  item: FillableItem,
  deps?: FillDeps,
): Promise<FillResult> {
  const snapshot: Snapshot = {
    itemType: readItemType(item),
    fields: {},
    creators: [],
  };
  for (const field of SNAPSHOT_FIELDS) {
    const value = item.getField(field);
    if (value !== undefined) {
      snapshot.fields[field] = value;
    }
  }
  const rawCreators = item.getCreators();
  snapshot.creators = Array.isArray(rawCreators) ? rawCreators : [];

  const doiSource: ItemSnapshot = {
    DOI: snapshot.fields.DOI,
    extra: snapshot.fields.extra,
  };
  const doi = extractDoi(doiSource);
  if (doi === null) {
    return { status: "skipped-no-doi", changed: [] };
  }

  const fetchCsl = deps?.fetchCsl ?? fetchWithDefault;
  let fetched: FetchCslResult;
  try {
    fetched = await fetchCsl(doi);
  } catch (err) {
    return { status: "failed", changed: [], reason: "fetch-error: " + String(err) };
  }
  if (!fetched.ok) {
    return { status: "failed", changed: [], reason: fetched.reason };
  }

  try {
    const mapped = mapCslToZotero(fetched.csl);
    const changes = computeChanges(snapshot, mapped);

    if (
      Object.keys(changes.fieldsToSet).length === 0 &&
      changes.creatorsAction === "none" &&
      changes.itemTypeTo === undefined
    ) {
      return { status: "skipped-complete", changed: [] };
    }

    const changed: string[] = [];
    const skipped: string[] = [];
    // Apply setType FIRST: Zotero's setField throws
    // "'<field>' is not a valid field for type '<type>'" when the field is
    // invalid for the CURRENT type (e.g. publicationTitle on a webpage), so
    // the item must be upgraded to its target type before the field loop.
    if (changes.itemTypeTo !== undefined) {
      const typeID = deps?.getTypeID
        ? deps.getTypeID(changes.itemTypeTo)
        : 1;
      item.setType(typeID);
      changed.push("itemType");
    }
    for (const [field, value] of Object.entries(changes.fieldsToSet)) {
      try {
        item.setField(field, value);
        changed.push(field);
      } catch (err) {
        // Skip only the failing field; never abort the whole fill.
        skipped.push(field);
      }
    }
    if (changes.creatorsAction === "set") {
      item.setCreators(changes.newCreators!);
      changed.push("creators");
    }

    await item.saveTx();
    const result: FillResult = { status: "filled", changed };
    if (skipped.length > 0) {
      result.skipped = skipped;
    }
    return result;
  } catch (err) {
    return { status: "failed", changed: [], reason: "apply-error: " + String(err) };
  }
}
