// Real Zotero runtime bindings. This is the ONLY module allowed to reference
// the Zotero global directly; every other module receives duck-typed adapters.
import type { LibrarySource } from "./batch";
import type { FillableItem } from "./fill";
import type { FetchCslResult, HttpGet } from "./fetch-metadata";
import { fetchCslByDoi } from "./fetch-metadata";

type HttpGetResponse = {
  status: number;
  json?: any;
  text?: string;
};

type AbortControllerCtor = new () => {
  signal: unknown;
  abort(): void;
};

// The plugin sandbox on Zotero 10 exposes only the globals listed in
// plugins.js (wantGlobalProperties), which does not include AbortController.
// Resolve the constructor from the sandbox global first, then from the
// hidden DOM window, so the fetch fallback can still abort on timeout.
function getAbortControllerCtor(): AbortControllerCtor | undefined {
  const g = globalThis as any;
  if (typeof g.AbortController === "function") {
    return g.AbortController as AbortControllerCtor;
  }
  try {
    const hidden = (Services as any).appShell?.hiddenDOMWindow;
    if (hidden && typeof hidden.AbortController === "function") {
      return hidden.AbortController.bind(hidden) as AbortControllerCtor;
    }
  } catch {
    // no AbortController available anywhere
  }
  return undefined;
}

function fetchWithTimeout(
  fetchFn: (...args: any[]) => Promise<any>,
  url: string,
  opts: { headers: Record<string, string>; timeout: number },
): Promise<HttpGetResponse> {
  const ctor = getAbortControllerCtor();
  const controller = ctor ? new ctor() : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeout)
    : undefined;
  return fetchFn(url, {
    method: "GET",
    headers: opts.headers,
    redirect: "follow",
    ...(controller ? { signal: controller.signal } : {}),
  })
    .then(async (res: any) => ({ status: res.status, text: await res.text() }))
    .catch((err: unknown) => {
      if (controller && (controller.signal as any)?.aborted) {
        throw new Error(
          `DoiMetaFill fetch timeout after ${opts.timeout}ms for ${url}`,
        );
      }
      throw err;
    })
    .finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
}

// With responseType "json", Zotero parses the body into xhr.response, while
// reading xhr.responseText throws InvalidStateError per the WHATWG XHR spec
// (observed on Zotero 10 beta). Zotero's legacy responseJSON property does not
// exist in Zotero 10. Read xhr.response first and only fall back to
// responseText under a try/catch.
function safeResponseJson(xhr: XMLHttpRequest): unknown {
  try {
    const response = (xhr as any).response;
    if (response !== undefined && response !== null) {
      return response;
    }
  } catch {
    // response getter unavailable; treat as no JSON body
  }
  return undefined;
}

function safeResponseText(xhr: XMLHttpRequest): string | undefined {
  try {
    const text = (xhr as any).responseText;
    return typeof text === "string" ? text : undefined;
  } catch {
    // InvalidStateError: responseText is not readable while
    // responseType is "json". Leave text undefined.
    return undefined;
  }
}

// Wrap Zotero.HTTP.request so it satisfies the HttpGet contract of
// fetch-metadata.ts: always resolves with { status, json?, text? } instead of
// rejecting on non-2XX (successCodes: false), leaving retry/status
// classification to the pure fetchCslByDoi module.
export const zoteroHttpGet: HttpGet = (url, opts) => {
  if (
    typeof Zotero !== "undefined" &&
    typeof Zotero.HTTP?.request === "function"
  ) {
    return Zotero.HTTP.request("GET", url, {
      headers: opts.headers,
      responseType: "json",
      timeout: opts.timeout,
      successCodes: false,
    }).then((xhr: XMLHttpRequest) => {
      const response: HttpGetResponse = { status: xhr.status };
      const json = safeResponseJson(xhr);
      if (json !== undefined) {
        response.json = json;
      } else {
        const text = safeResponseText(xhr);
        if (typeof text === "string") {
          response.text = text;
        }
      }
      return response;
    });
  }
  // Zotero 10 beta: no Zotero.HTTP yet, fall back to the global fetch.
  const fetchFn: (...args: any[]) => Promise<any> = (globalThis as any).fetch;
  return fetchWithTimeout(fetchFn, url, {
    headers: opts.headers,
    timeout: opts.timeout,
  });
};

export function createFetchCsl(): (
  doi: string,
) => Promise<FetchCslResult> {
  return (doi: string) =>
    fetchCslByDoi(doi, zoteroHttpGet, {
      log: (s: string) => Zotero.debug("DoiMetaFill fetch: " + s),
    });
}

export function createGetTypeID(): (typeName: string) => number {
  return (typeName: string) => Zotero.ItemTypes.getID(typeName) as number;
}

// ---- B1/E: internal <-> JSON creator format translation -------------------
//
// Zotero.Item.getCreators() returns the INTERNAL format: each entry is
// {creatorTypeID: number, fieldMode: 0|1, firstName?, lastName?} with NO
// 'creatorType' string. The pure modules (fill-policy, batch) match on
// c.creatorType === "author", so raw internal creators always looked like
// "zero authors", forcing creatorsAction="set" on every run and duplicating
// authors. The wrapper translates at the boundary (this file only).
//
// Verified against the installed Zotero (C:\Program Files\Zotero\app\omni.ja,
// 10.0-beta.22+4ec5ba9c2):
//   - Zotero.Creators.internalToJSON(fields)
//     chrome/content/zotero/xpcom/data/creators.js:255-266
//     (fieldMode==1 -> {name: lastName}; else {firstName, lastName};
//     creatorType via Zotero.CreatorTypes.getName(fields.creatorTypeID))
//   - WRITE direction (Defect E fix): Zotero.Item.prototype.setCreators
//     (chrome/content/zotero/xpcom/data/item.js:1446-1461) is documented and
//     implemented for "an array of creator data in internal or API JSON
//     format"; each entry goes through setCreator (item.js:1395-1443), which
//     calls Zotero.Creators.cleanData (creators.js:186-252) -- Zotero's own
//     JSON->internal converter ({creatorType, firstName, lastName} ->
//     {fieldMode:0, firstName, lastName, creatorTypeID}; {creatorType, name}
//     -> {fieldMode:1, lastName: name, creatorTypeID}).
//   - The previous hand-rolled creatorsFromJson captured
//     Zotero.CreatorTypes.getID and called it WITHOUT `this`. getID reads
//     this._types (cachedTypes.js:98-116), so the unbound call always took
//     the UnloadedDataException branch and threw via
//     Zotero.Utilities.capitalize (utilities.js:1137-1141):
//     "Error: Argument must be a string". Every creators write aborted as
//     "apply-error: Error: Argument must be a string" (observed live).
//     Therefore creatorsFromJson now passes the JSON-style creators through
//     unchanged: the real item.setCreators -> cleanData performs the
//     conversion with a properly bound getID inside Zotero's own scope.

export type WrappedCreator = {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
};

export type InternalCreator = {
  creatorTypeID: number;
  fieldMode: 0 | 1;
  firstName?: string;
  lastName?: string;
  name?: string;
};

type ZoteroLike = {
  Creators: {
    internalToJSON(fields: {
      creatorTypeID: number;
      fieldMode: number;
      firstName?: string;
      lastName?: string;
    }): WrappedCreator;
  };
};

// Resolve the Zotero namespace through the global object so the translators
// stay usable (with a manual fallback) outside the Zotero runtime.
function zoteroNamespace(): ZoteroLike | undefined {
  const g = globalThis as unknown as Record<string, unknown>;
  return g.Zotero as ZoteroLike | undefined;
}

// internal -> JSON, via the verified Zotero helper. Falls back to a manual
// mapping if the helper is missing (e.g. tests running outside Zotero).
export function creatorsToJson(internal: InternalCreator[]): WrappedCreator[] {
  const internalToJSON = zoteroNamespace()?.Creators?.internalToJSON;
  if (typeof internalToJSON === "function") {
    return internal.map((c) => internalToJSON(c));
  }
  return internal.map((c) => ({
    creatorType: "author",
    ...(c.fieldMode === 1
      ? { name: c.lastName ?? c.name ?? "" }
      : { firstName: c.firstName ?? "", lastName: c.lastName ?? "" }),
  }));
}

// JSON -> internal is performed by the REAL item: setCreators -> setCreator
// -> Zotero.Creators.cleanData (verified creators.js:186-252, item.js:1404).
// The JSON-style array is passed through unchanged; hand-rolling the
// conversion here was Defect E (the unbound Zotero.CreatorTypes.getID call
// threw "Argument must be a string").
export function creatorsFromJson(creators: WrappedCreator[]): WrappedCreator[] {
  return creators;
}

// Wrap a REAL Zotero item so pure modules see the JSON creator format. The
// wrapper is a NEW object; the underlying Zotero item is never mutated by the
// adapter itself.
export type WrappedItem = FillableItem & { key: string; itemType: string };

export function wrapItem(item: any): WrappedItem {
  return {
    key: item.key,
    get itemType() {
      return item.itemType;
    },
    getField: (field: string) => item.getField(field),
    setField: (field: string, value: string) => item.setField(field, value),
    getCreators: () => creatorsToJson(item.getCreators()),
    setCreators: (creators) => item.setCreators(creatorsFromJson(creators)),
    setType: (typeID: number) => item.setType(typeID),
    saveTx: () => item.saveTx(),
  };
}

export function createLibrarySource(): LibrarySource {
  return {
    getAllItems: async () => {
      const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
      return items
        .filter(
          (it) =>
            it.isRegularItem() &&
            !it.deleted &&
            !it.isNote() &&
            !it.isAttachment(),
        )
        .map((it) => ({ key: it.key, item: wrapItem(it) }));
    },
    confirm: (message: string) => {
      const win = Zotero.getMainWindows()[0];
      return Promise.resolve(
        Services.prompt.confirm(
          win as unknown as mozIDOMWindowProxy,
          "DOI Metadata Fill",
          message,
        ),
      );
    },
  };
}
