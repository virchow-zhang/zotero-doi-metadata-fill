// Batch operations: fill many items from a library source and summarize the
// outcome. Like the other modules, this NEVER imports the Zotero runtime;
// the caller (plugin entry) supplies duck-typed adapters (a later todo binds
// the real Zotero.Items / Zotero.Libraries and the UI confirm dialog).
import type { FillableItem, FillDeps, FillResult } from "./fill";
import { fillItem } from "./fill";
import { extractDoi } from "./doi";
import { runPool } from "./fetch-metadata";

export type FillStats = {
  filled: number; // status === "filled"
  skippedNoDoi: number; // "skipped-no-doi"
  skippedComplete: number; // "skipped-complete"
  failed: number; // "failed"
  failures: Array<{ doi?: string; reason?: string }>; // capped at 20 entries
  changedFields: Set<string>; // union of changed fields across filled items
  cancelled?: boolean;
};

export type BatchItem = { key: string; item: FillableItem; doi?: string };

// A duck-typed "library source": the caller (plugin entry) supplies adapters.
export interface LibrarySource {
  getAllItems(): Promise<BatchItem[]>; // all regular top-level items (plugin entry filters trash/attachment/note)
  confirm(message: string): Promise<boolean>; // returns true to proceed
}

export interface NeedsFillSnapshot {
  itemType: string;
  fields: Record<string, string>;
  creators: Array<{ creatorType: string }>;
}

const NEEDS_FILL_FIELDS = ["publicationTitle", "volume", "pages"] as const;

// True iff the snapshot has no author creator, or any of publicationTitle /
// volume / pages is empty (undefined or ""). Pure function.
export function needsFill(snapshot: NeedsFillSnapshot): boolean {
  const hasAuthor = snapshot.creators.some(
    (c) => c.creatorType === "author",
  );
  if (!hasAuthor) {
    return true;
  }
  for (const field of NEEDS_FILL_FIELDS) {
    const value = snapshot.fields[field];
    if (value === undefined || value === "") {
      return true;
    }
  }
  return false;
}

// itemType comes from two supported shapes (mirrors fill.ts):
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

function snapshotOf(item: FillableItem): NeedsFillSnapshot {
  const fields: Record<string, string> = {};
  for (const field of NEEDS_FILL_FIELDS) {
    const value = item.getField(field);
    if (value !== undefined) {
      fields[field] = value;
    }
  }
  const rawCreators = item.getCreators();
  return {
    itemType: readItemType(item),
    fields,
    creators: Array.isArray(rawCreators) ? rawCreators : [],
  };
}

export async function collectLibraryCandidates(
  lib: LibrarySource,
  needsFillFn: typeof needsFill = needsFill,
): Promise<BatchItem[]> {
  const all = await lib.getAllItems();
  const candidates: BatchItem[] = [];
  for (const bi of all) {
    const doi = extractDoi({
      DOI: bi.item.getField("DOI"),
      extra: bi.item.getField("extra"),
    });
    if (doi === null) {
      continue;
    }
    if (!needsFillFn(snapshotOf(bi.item))) {
      continue;
    }
    candidates.push({ key: bi.key, item: bi.item, doi });
  }
  return candidates;
}

const MAX_FAILURES = 20;

export async function fillItems(
  items: BatchItem[],
  deps: FillDeps,
  opts?: {
    confirm?: (message: string) => Promise<boolean>;
    candidateCount?: number;
  },
): Promise<FillStats> {
  let toProcess = items;
  if (opts?.confirm !== undefined && opts.candidateCount === undefined) {
    const candidates = items.filter((bi) => needsFill(snapshotOf(bi.item)));
    const ok = await opts.confirm(
      `将对 ${candidates.length} 条候选条目批量补全，确定继续？`,
    );
    if (!ok) {
      return {
        filled: 0,
        skippedNoDoi: 0,
        skippedComplete: 0,
        failed: 0,
        failures: [],
        changedFields: new Set(),
        cancelled: true,
      };
    }
    toProcess = candidates;
  }

  const entries = await runPool(
    toProcess,
    (bi) => fillItem(bi.item, deps),
    { concurrency: 3, minIntervalMs: 300 },
  );

  const stats: FillStats = {
    filled: 0,
    skippedNoDoi: 0,
    skippedComplete: 0,
    failed: 0,
    failures: [],
    changedFields: new Set(),
  };

  for (const { item: bi, result } of entries) {
    switch (result.status) {
      case "filled":
        stats.filled++;
        for (const field of result.changed) {
          stats.changedFields.add(field);
        }
        break;
      case "skipped-no-doi":
        stats.skippedNoDoi++;
        break;
      case "skipped-complete":
        stats.skippedComplete++;
        break;
      case "failed":
        stats.failed++;
        if (stats.failures.length < MAX_FAILURES) {
          stats.failures.push({ doi: bi.doi, reason: result.reason });
        }
        break;
    }
  }

  return stats;
}

export function summarizeResults(stats: FillStats): string {
  const line =
    `补全成功 ${stats.filled} / 跳过-无DOI ${stats.skippedNoDoi}` +
    ` / 跳过-已完整 ${stats.skippedComplete} / 失败 ${stats.failed}`;
  return stats.cancelled ? line + "（已取消）" : line;
}
