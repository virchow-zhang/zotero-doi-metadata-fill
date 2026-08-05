// Plugin UI layer: menu registration, progress report, lifecycle cleanup and
// the global Zotero.DoiMetaFill API. Imports the Zotero runtime global
// (allowed here and in zotero-adapters.ts only).
import { config } from "../../package.json";
import type { FluentMessageId } from "../../typings/i10n";
import { getString } from "../utils/locale";
import type { BatchItem, FillStats } from "./batch";
import { collectLibraryCandidates, fillItems, needsFill, summarizeResults } from "./batch";
import { fillItem } from "./fill";
import {
  createFetchCsl,
  createGetTypeID,
  createLibrarySource,
  wrapItem,
} from "./zotero-adapters";

const ITEM_MENU_ITEM_ID = "doimetafill-itemmenu-fill";
const TOOLS_MENU_ITEM_ID = "doimetafill-tools-fillall";

// Zotero.Prefs.get() prepends its own branch ("extensions.zotero.") when the
// global flag is not set, so this must be the short name (see Zotero prefs.js:
// `pref = global ? pref : ZOTERO_CONFIG.PREF_BRANCH + pref;`).
// The registered default lives at extensions.zotero.doiMetaFill.selfTest.
const SELFTEST_PREF = "doiMetaFill.selfTest";
const SELFTEST_RESULT_PATH =
  "C:\\Users\\zhang\\zotero-doi-metadata\\.qa\\selftest-result.json";

function menuLabel(key: FluentMessageId, fallback: string): string {
  try {
    const resolved = getString(key);
    if (resolved !== `${config.addonRef}-${key}`) {
      return resolved;
    }
  } catch {
    // locale not ready yet; fall through to the hardcoded label
  }
  return fallback;
}

export function registerMenus(win: _ZoteroTypes.MainWindow): void {
  const doc = win.document;
  const itemMenu = doc.getElementById("zotero-itemmenu");
  if (itemMenu && doc.getElementById(ITEM_MENU_ITEM_ID) === null) {
    const item = doc.createElement("menuitem");
    item.id = ITEM_MENU_ITEM_ID;
    item.setAttribute("label", menuLabel("itemmenu-fill", "按 DOI 补全题录"));
    item.addEventListener("command", () => handleSelected());
    itemMenu.appendChild(item);
  }
  const toolsMenu = doc.getElementById("menu_ToolsPopup");
  if (toolsMenu && doc.getElementById(TOOLS_MENU_ITEM_ID) === null) {
    const item = doc.createElement("menuitem");
    item.id = TOOLS_MENU_ITEM_ID;
    item.setAttribute(
      "label",
      menuLabel("tools-fillall", "批量补全 DOI 题录（全库）"),
    );
    item.addEventListener("command", () => handleLibrary());
    toolsMenu.appendChild(item);
  }
}

export function unregisterMenus(win: Window): void {
  const doc = win.document;
  doc.getElementById(ITEM_MENU_ITEM_ID)?.remove();
  doc.getElementById(TOOLS_MENU_ITEM_ID)?.remove();
}

function handleSelected(): void {
  const items = Zotero.getActiveZoteroPane()
    .getSelectedItems()
    .filter((it) => it.isRegularItem());
  const batchItems: BatchItem[] = items.map((it) => ({
    key: it.key,
    item: wrapItem(it),
  }));
  void fillItems(
    batchItems,
    { fetchCsl: createFetchCsl(), getTypeID: createGetTypeID() },
    { candidateCount: items.length },
  )
    .then(report)
    .catch((err) =>
      ztoolkit.log("DoiMetaFill handleSelected error", String(err)),
    );
}

function handleLibrary(): void {
  void (async () => {
    const lib = createLibrarySource();
    const candidates = await collectLibraryCandidates(lib);
    if (candidates.length === 0) {
      Zotero.alert(Zotero.getMainWindow(), "DOI Metadata Fill", "未找到需要补全的条目");
      return;
    }
    const ok = await lib.confirm(
      `找到 ${candidates.length} 条需要补全的条目，确定继续？`,
    );
    if (!ok) {
      return;
    }
    const stats = await fillItems(
      candidates,
      { fetchCsl: createFetchCsl(), getTypeID: createGetTypeID() },
      { candidateCount: candidates.length },
    );
    report(stats);
  })().catch((err) =>
    ztoolkit.log("DoiMetaFill handleLibrary error", String(err)),
  );
}

function report(stats: FillStats): void {
  const pw = new Zotero.ProgressWindow({ closeOnClick: true });
  pw.addLines(
    [summarizeResults(stats)] as unknown as string,
    "chrome://zotero/skin/16/universal/tick.svg",
  );
  pw.show();
  Zotero.debug(JSON.stringify(stats));
  if (stats.failures.length > 0) {
    const lines = stats.failures
      .slice(0, 20)
      .map((f) => `${f.doi ?? "(unknown doi)"}: ${f.reason ?? "unknown error"}`);
    Zotero.alert(
      Zotero.getMainWindow(),
      "DOI Metadata Fill",
      `部分条目补全失败：\n${lines.join("\n")}`,
    );
  }
}

export function exposeApi(): void {
  const api = {
    fillItem,
    fillItems,
    collectLibraryCandidates,
    needsFill,
    createFetchCsl,
    createGetTypeID,
    createLibrarySource,
  };
  const existing = (Zotero as any).DoiMetaFill;
  if (existing && typeof existing === "object") {
    Object.assign(existing, api);
  } else {
    (Zotero as any).DoiMetaFill = api;
  }
  if (Zotero.Prefs.get(SELFTEST_PREF) === true) {
    void selfTest();
  }
}

async function selfTest(): Promise<void> {
  const result: { [key: string]: unknown } = {
    ok: true,
    checkedAt: new Date().toISOString(),
  };
  try {
    result.typeofChecks = {
      Zotero: typeof Zotero,
      "Zotero.HTTP.request": typeof Zotero.HTTP?.request,
      fillItem: typeof fillItem,
      fillItems: typeof fillItems,
      collectLibraryCandidates: typeof collectLibraryCandidates,
      needsFill: typeof needsFill,
      createFetchCsl: typeof createFetchCsl,
      createGetTypeID: typeof createGetTypeID,
      createLibrarySource: typeof createLibrarySource,
    };

    const deps = { fetchCsl: createFetchCsl(), getTypeID: createGetTypeID() };
    const tempItems: Zotero.Item[] = [];

    const good = new Zotero.Item("journalArticle");
    good.setField("DOI", "10.1038/ng.3834");
    await good.saveTx();
    tempItems.push(good);
    const goodResult = await fillItem(wrapItem(good), deps);
    result.goodDoiItem = {
      status: goodResult.status,
      changed: goodResult.changed,
      skipped: goodResult.skipped ?? null,
      // Defect E: the apply-error reason (e.g. the real setCreators
      // exception) must land in the self-test result file, not be swallowed.
      reason: goodResult.reason ?? null,
      creatorsCount: good.getCreators().length,
      publicationTitle: good.getField("publicationTitle"),
      date: good.getField("date"),
    };

    const bad = new Zotero.Item("journalArticle");
    bad.setField("DOI", "10.0000/definitely-not-real");
    await bad.saveTx();
    tempItems.push(bad);
    const beforeTitle = bad.getField("title");
    const beforePublication = bad.getField("publicationTitle");
    const badResult = await fillItem(wrapItem(bad), deps);
    result.badDoiItem = {
      status: badResult.status,
      reason: badResult.reason ?? null,
      fieldsUnchanged:
        bad.getField("title") === beforeTitle &&
        bad.getField("publicationTitle") === beforePublication,
    };

    result.batchCheck = await runBatchCheck(deps);
    result.domCheck = await runDomCheck();

    for (const item of tempItems) {
      try {
        await item.eraseTx();
      } catch (err) {
        Zotero.debug(
          "DoiMetaFill self-test: eraseTx failed for temp item: " + String(err),
        );
      }
    }
  } catch (err) {
    result.ok = false;
    result.error = String(err);
  }
  await writeSelftestResult(result);
}

// F1 remediation: exercise the batch pipeline (fillItems) against three
// live-created items covering filled / skipped-no-doi / skipped-complete, and
// assert the wrapped creator translation (B1) is visible to needsFill.
async function runBatchCheck(deps: {
  fetchCsl: ReturnType<typeof createFetchCsl>;
  getTypeID: (typeName: string) => number;
}): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { pass: false, detail: "" };
  const tempItems: Zotero.Item[] = [];
  try {
    // (1) journalArticle with DOI, empty fields -> filled
    const item1 = new Zotero.Item("journalArticle");
    item1.setField("DOI", "10.1038/ng.3834");
    await item1.saveTx();
    tempItems.push(item1);

    // (2) journalArticle with no DOI -> skipped-no-doi
    const item2 = new Zotero.Item("journalArticle");
    await item2.saveTx();
    tempItems.push(item2);

    // (3) journalArticle with DOI + ALL fields pre-filled + one author set in
    // INTERNAL format ({creatorTypeID, fieldMode, firstName, lastName}) ->
    // the wrapper must translate it so the policy sees an author; with every
    // field already matching and the author not among the mapped authors the
    // fill decides nothing needs to change -> skipped-complete.
    const item3 = new Zotero.Item("journalArticle");
    item3.setField("DOI", "10.1038/ng.3834");
    item3.setField("title", "The impact of structural variation on human gene expression");
    item3.setField("publicationTitle", "Nature Genetics");
    item3.setField("date", "2017-04-03");
    item3.setField("volume", "49");
    item3.setField("issue", "5");
    item3.setField("pages", "692-699");
    item3.setField("ISSN", "1061-4036");
    item3.setField(
      "publisher",
      "Springer Science and Business Media LLC",
    );
    item3.setField("url", "http://dx.doi.org/10.1038/ng.3834");
    item3.setField("language", "en");
    item3.setCreators(
      [
        {
          creatorTypeID: Zotero.CreatorTypes.getID("author"),
          fieldMode: 0,
          firstName: "Tester",
          lastName: "Testerson",
        },
      ] as unknown as _ZoteroTypes.Item.Creator[],
    );
    await item3.saveTx();
    tempItems.push(item3);

    const wrapped3 = wrapItem(item3);
    const item3NeedsFill = needsFill({
      itemType: wrapped3.itemType,
      fields: {
        publicationTitle: wrapped3.getField("publicationTitle") ?? "",
        volume: wrapped3.getField("volume") ?? "",
        pages: wrapped3.getField("pages") ?? "",
      },
      creators: wrapped3.getCreators(),
    });

    const batchItems: BatchItem[] = [item1, item2, item3].map((it) => ({
      key: it.key,
      item: wrapItem(it),
    }));
    // candidateCount bypasses the needsFill pre-filter so the complete item
    // (3) is processed and reports skipped-complete; the confirm resolves
    // true if it were consulted.
    const stats = await fillItems(batchItems, deps, {
      confirm: async () => true,
      candidateCount: batchItems.length,
    });

    out.counts = {
      filled: stats.filled,
      skippedNoDoi: stats.skippedNoDoi,
      skippedComplete: stats.skippedComplete,
      failed: stats.failed,
    };
    out.item3WrappedCreators = wrapped3.getCreators();
    out.item3NeedsFill = item3NeedsFill;
    out.pass =
      stats.filled === 1 &&
      stats.skippedNoDoi === 1 &&
      stats.skippedComplete === 1 &&
      stats.failed === 0 &&
      item3NeedsFill === false;
    out.detail = out.pass
      ? "expected counts achieved; wrapped creator translation confirmed"
      : `counts/needsFill mismatch: ${JSON.stringify({
          counts: out.counts,
          item3NeedsFill,
        })}`;
  } catch (err) {
    out.pass = false;
    out.detail = String(err);
  } finally {
    for (const item of tempItems) {
      try {
        await item.eraseTx();
      } catch {
        // best-effort cleanup
      }
    }
  }
  return out;
}

// F1 remediation: assert menu DOM registration, the unregister cleanup, and
// re-registration so the UI stays functional afterwards.
async function runDomCheck(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { pass: false, detail: "" };
  try {
    const win = Zotero.getMainWindows()[0] as unknown as Window;
    const doc = win.document;
    const before = {
      itemMenu: doc.getElementById("doimetafill-itemmenu-fill") !== null,
      toolsMenu: doc.getElementById("doimetafill-tools-fillall") !== null,
    };
    unregisterMenus(win);
    const afterUnregister = {
      itemMenu: doc.getElementById("doimetafill-itemmenu-fill") !== null,
      toolsMenu: doc.getElementById("doimetafill-tools-fillall") !== null,
    };
    registerMenus(win as _ZoteroTypes.MainWindow);
    const afterReregister = {
      itemMenu: doc.getElementById("doimetafill-itemmenu-fill") !== null,
      toolsMenu: doc.getElementById("doimetafill-tools-fillall") !== null,
    };
    out.before = before;
    out.afterUnregister = afterUnregister;
    out.afterReregister = afterReregister;
    out.pass =
      before.itemMenu &&
      before.toolsMenu &&
      !afterUnregister.itemMenu &&
      !afterUnregister.toolsMenu &&
      afterReregister.itemMenu &&
      afterReregister.toolsMenu;
    out.detail = out.pass
      ? "menus present before, absent after unregister, present after re-register"
      : `DOM mismatch: ${JSON.stringify({ before, afterUnregister, afterReregister })}`;
  } catch (err) {
    out.pass = false;
    out.detail = String(err);
  }
  return out;
}

async function writeSelftestResult(result: { [key: string]: unknown }): Promise<void> {
  const dir = "C:\\Users\\zhang\\zotero-doi-metadata\\.qa";
  const file = SELFTEST_RESULT_PATH;
  const json = JSON.stringify(result, null, 2);
  const failures: string[] = [];
  try {
    await IOUtils.makeDirectory(dir, {
      createAncestors: true,
      ignoreExisting: true,
    });
  } catch (err) {
    failures.push(`makeDirectory: ${String(err)}`);
    Zotero.debug(
      "DoiMetaFill self-test: makeDirectory failed: " + String(err),
    );
  }
  try {
    await IOUtils.writeUTF8(file, json, { tmpPath: `${file}.tmp` });
    return;
  } catch (err) {
    failures.push(`IOUtils.writeUTF8: ${String(err)}`);
    Zotero.debug(
      "DoiMetaFill self-test write fallback 1 failed: " + String(err),
    );
  }
  try {
    await IOUtils.writeJSON(file, result, { tmpPath: `${file}.tmp` });
    return;
  } catch (err) {
    failures.push(`IOUtils.writeJSON: ${String(err)}`);
    Zotero.debug(
      "DoiMetaFill self-test write fallback 2 failed: " + String(err),
    );
  }
  try {
    // Sync variant: implemented with nsIFileOutputStream, no OS.File
    // dependency; requires an nsIFile argument.
    Zotero.File.putContents(Zotero.File.pathToFile(file), json);
    return;
  } catch (err) {
    failures.push(`Zotero.File.putContents: ${String(err)}`);
    Zotero.debug(
      "DoiMetaFill self-test write fallback 3 failed: " + String(err),
    );
  }
  Zotero.debug(
    "DoiMetaFill self-test: ALL write fallbacks failed; result file not " +
      `written. Errors: ${failures.join(" | ")}`,
  );
}
