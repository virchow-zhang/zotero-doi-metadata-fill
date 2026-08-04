export interface ItemSnapshot {
  DOI?: string;
  extra?: string;
}

const DOI_PREFIXES = [
  "doi:",
  "DOI:",
  "https://doi.org/",
  "http://doi.org/",
  "https://dx.doi.org/",
  "http://dx.doi.org/",
  "doi.org/",
] as const;

const EXTRA_DOI_RE = /^\s*doi\s*:\s*(\S+)/im;
const VALID_DOI_RE = /^10\.\d{4,9}\/\S+$/;

export function extractDoi(itemSnapshot: ItemSnapshot): string | null {
  let raw: string | undefined;
  if (typeof itemSnapshot.DOI === "string" && itemSnapshot.DOI.trim() !== "") {
    raw = itemSnapshot.DOI;
  } else if (typeof itemSnapshot.extra === "string") {
    const match = itemSnapshot.extra.match(EXTRA_DOI_RE);
    if (match) {
      raw = match[1];
    }
  }
  if (raw === undefined) {
    return null;
  }

  let normalized = raw.trim();
  for (const prefix of DOI_PREFIXES) {
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // keep the undecoded string
  }
  normalized = normalized.toLowerCase();
  normalized = normalized.replace(/[.,;]+$/, "");

  return VALID_DOI_RE.test(normalized) ? normalized : null;
}
