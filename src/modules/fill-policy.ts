export type Snapshot = {
  itemType: string;
  fields: Record<string, string>;
  creators: Array<{ creatorType: string; lastName?: string; name?: string }>;
};

export type Mapped = {
  itemType?: string;
  fields: Record<string, string>;
  creators: Array<{
    creatorType: "author";
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
};

export type Changes = {
  fieldsToSet: Record<string, string>;
  creatorsAction: "none" | "set";
  newCreators?: Array<{
    creatorType: string;
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
  itemTypeTo?: string;
};

const UPGRADE_SOURCES = new Set(["webpage", "preprint"]);
const UPGRADE_TARGETS = new Set(["journalArticle", "conferencePaper", "bookSection"]);

function familyNameOf(c: { lastName?: string; name?: string }): string {
  return (c.lastName ?? c.name ?? "").toLowerCase();
}

export function computeChanges(snapshot: Snapshot, mapped: Mapped): Changes {
  const fieldsToSet: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapped.fields)) {
    const current = snapshot.fields[key];
    if (current === undefined || current === "") {
      fieldsToSet[key] = value;
    }
  }

  if (
    Object.keys(mapped.fields).length === 0 &&
    mapped.creators.length === 0 &&
    mapped.itemType === undefined
  ) {
    return { fieldsToSet: {}, creatorsAction: "none" };
  }

  const snapshotAuthors = snapshot.creators.filter((c) => c.creatorType === "author");
  const mappedAuthors = mapped.creators.filter((c) => c.creatorType === "author");

  let creatorsAction: "none" | "set" = "none";
  if (snapshotAuthors.length === 0) {
    creatorsAction = "set";
  } else if (mappedAuthors.length > snapshotAuthors.length) {
    const newAuthorNames = new Set(mappedAuthors.map(familyNameOf));
    // Only replace the existing author list when EVERY existing surname also
    // appears in the mapped set; a single partial surname match is not enough
    // to risk dropping existing authors.
    const allExistingMatch = snapshotAuthors.every((a) =>
      newAuthorNames.has(familyNameOf(a)),
    );
    if (allExistingMatch) {
      creatorsAction = "set";
    }
  }

  const itemTypeTo =
    UPGRADE_SOURCES.has(snapshot.itemType) &&
    mapped.itemType !== undefined &&
    UPGRADE_TARGETS.has(mapped.itemType)
      ? mapped.itemType
      : undefined;

  const result: Changes = { fieldsToSet, creatorsAction };
  if (creatorsAction === "set") {
    result.newCreators = [
      ...mapped.creators,
      ...snapshot.creators.filter((c) => c.creatorType !== "author"),
    ];
  }
  if (itemTypeTo !== undefined) {
    result.itemTypeTo = itemTypeTo;
  }
  return result;
}
