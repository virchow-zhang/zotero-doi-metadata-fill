export interface MappedCreator {
  creatorType: "author";
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface MappedItem {
  itemType?: string;
  fields: Record<string, string>;
  creators: MappedCreator[];
}

const TYPE_MAP: Record<string, string> = {
  "article-journal": "journalArticle",
  "journal-article": "journalArticle",
  "paper-conference": "conferencePaper",
  "proceedings-article": "conferencePaper",
  book: "book",
  chapter: "bookSection",
  thesis: "thesis",
  manuscript: "preprint",
  dataset: "dataset",
};

function formatDate(csl: any): string | undefined {
  const issued = csl?.issued;
  if (!issued || typeof issued !== "object") return undefined;
  const parts = issued["date-parts"] ?? issued.dateParts;
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const dp = parts[0];
  if (!Array.isArray(dp) || dp.length === 0) return undefined;
  const [year, month, day] = dp;
  if (year === undefined || year === null || year === "") return undefined;
  const y = String(year);
  if (month === undefined || month === null || month === "") return y;
  const m = String(month).padStart(2, "0");
  if (day === undefined || day === null || day === "") return `${y}-${m}`;
  return `${y}-${m}-${String(day).padStart(2, "0")}`;
}

function toFirstString(value: unknown): string | undefined {
  const target = Array.isArray(value) ? value[0] : value;
  if (target === undefined || target === null) return undefined;
  return String(target);
}

function normalizeDoi(doi: string): string {
  return doi
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
}

export function mapCslToZotero(csl: any): MappedItem {
  const itemType = TYPE_MAP[csl?.type];
  const fields: Record<string, string> = {};

  if (csl?.title) fields.title = String(csl.title);

  const containerTitle = toFirstString(csl?.["container-title"]);
  if (containerTitle) {
    fields[
      itemType === "conferencePaper"
        ? "proceedingsTitle"
        : itemType === "bookSection"
          ? "bookTitle"
          : "publicationTitle"
    ] = containerTitle;
  }

  const shortContainer =
    toFirstString(csl?.["short-container-title"]) ??
    toFirstString(csl?.["shortContainer-title"]);
  if (shortContainer) fields.journalAbbreviation = shortContainer;

  const date = formatDate(csl);
  if (date !== undefined) fields.date = date;

  if (csl?.volume) fields.volume = String(csl.volume);
  if (csl?.issue) fields.issue = String(csl.issue);
  if (csl?.page) fields.pages = String(csl.page);

  const issn = toFirstString(csl?.ISSN);
  if (issn) fields.ISSN = issn;
  const isbn = toFirstString(csl?.ISBN);
  if (isbn) fields.ISBN = isbn;

  if (csl?.publisher) fields.publisher = String(csl.publisher);
  if (csl?.URL) fields.url = String(csl.URL);
  if (csl?.abstract) fields.abstractNote = String(csl.abstract);
  if (csl?.language) fields.language = String(csl.language);
  if (csl?.DOI) fields.DOI = normalizeDoi(String(csl.DOI));

  const creators: MappedCreator[] = [];
  const authorList = Array.isArray(csl?.author) ? csl.author : [];
  for (const person of authorList) {
    if (!person || typeof person !== "object") continue;
    if (person.literal) {
      creators.push({ creatorType: "author", name: String(person.literal) });
    } else if (person.name) {
      creators.push({ creatorType: "author", name: String(person.name) });
    } else {
      const creator: MappedCreator = { creatorType: "author" };
      if (person.given) creator.firstName = String(person.given);
      if (person.family) creator.lastName = String(person.family);
      creators.push(creator);
    }
  }

  const result: MappedItem = { fields, creators };
  if (itemType) result.itemType = itemType;
  return result;
}
