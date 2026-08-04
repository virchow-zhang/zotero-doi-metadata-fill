import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapCslToZotero } from "./csl-map";

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
const zenodo = loadFixture("zenodo");
const kdd = loadFixture("kdd");

const inlineJournalArticle = {
  type: "journal-article",
  title: "Inline Crossref-style journal article",
  "container-title": "Inline Journal of Testing",
  issued: { "date-parts": [[2023, 1, 15]] },
  volume: "12",
  issue: "3",
  page: "1-9",
  ISSN: ["1234-5678", "9999-8888"],
  publisher: "Inline Publishing",
  URL: "https://example.com/paper",
  abstract: "An abstract for inline fixture.",
  language: "en",
  DOI: "doi:10.1234/ABC.567",
  author: [
    { given: "Jane", family: "Doe" },
    { given: "John", family: "Smith" },
  ],
};

describe("mapCslToZotero: real fixtures", () => {
  it("maps Nature Genetics (journal-article with institutional author)", () => {
    const result = mapCslToZotero(ng3834);
    expect(result.itemType).toBe("journalArticle");
    expect(result.fields.publicationTitle).toBeTruthy();
    expect(result.fields.publicationTitle).toBe(ng3834["container-title"]);
    expect(result.creators.length).toBeGreaterThan(2);
    expect(result.fields.date).toMatch(/^2017/);
    expect(result.fields.DOI).toBe("10.1038/ng.3834");
    expect(result.creators[0]).toEqual({
      creatorType: "author",
      name: "GTEx Consortium",
    });
  });

  it("maps Zenodo dataset consistently with its own type field", () => {
    const result = mapCslToZotero(zenodo);
    const expected = mapCslToZotero({ type: zenodo.type });
    expect(result.itemType).toBe(expected.itemType);
    expect(result.itemType).toBe("dataset");
    expect(result.fields.title).toBe(zenodo.title);
    expect(result.fields.DOI).toBe("10.5281/zenodo.21610933");
    expect(result.fields.publisher).toBe("Zenodo");
    expect(result.fields.url).toBe(zenodo.URL);
    expect(result.creators[0]).toEqual({
      creatorType: "author",
      firstName: "Daniel",
      lastName: "Beránek",
    });
  });

  it("maps KDD paper to conferencePaper with proceedingsTitle", () => {
    const result = mapCslToZotero(kdd);
    expect(result.itemType).toBe("conferencePaper");
    expect(result.fields.proceedingsTitle).toBe(kdd["container-title"]);
    expect(result.fields.date).toMatch(/^2019/);
    expect(result.fields.pages).toBe(kdd.page);
    expect(result.creators.length).toBe(10);
  });
});

describe("mapCslToZotero: inline fixtures", () => {
  it("maps Crossref non-standard journal-article type", () => {
    const result = mapCslToZotero(inlineJournalArticle);
    expect(result.itemType).toBe("journalArticle");
    expect(result.fields.title).toBe(inlineJournalArticle.title);
    expect(result.fields.publicationTitle).toBe(
      inlineJournalArticle["container-title"],
    );
    expect(result.fields.date).toBe("2023-01-15");
    expect(result.fields.volume).toBe("12");
    expect(result.fields.issue).toBe("3");
    expect(result.fields.pages).toBe("1-9");
    expect(result.fields.ISSN).toBe("1234-5678");
    expect(result.fields.publisher).toBe("Inline Publishing");
    expect(result.fields.url).toBe("https://example.com/paper");
    expect(result.fields.abstractNote).toBe("An abstract for inline fixture.");
    expect(result.fields.language).toBe("en");
    expect(result.fields.DOI).toBe("10.1234/abc.567");
    expect(result.creators).toEqual([
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      { creatorType: "author", firstName: "John", lastName: "Smith" },
    ]);
  });

  it("zero-pads month and day; YYYY-MM when day missing; YYYY when only year", () => {
    expect(
      mapCslToZotero({ issued: { "date-parts": [[2023, 2, 5]] } }).fields.date,
    ).toBe("2023-02-05");
    expect(
      mapCslToZotero({ issued: { "date-parts": [[2023, 2]] } }).fields.date,
    ).toBe("2023-02");
    expect(
      mapCslToZotero({ issued: { "date-parts": [[2023]] } }).fields.date,
    ).toBe("2023");
  });

  it("maps container-title to publicationTitle when itemType is undefined", () => {
    const result = mapCslToZotero({
      "container-title": "Mystery Source",
      title: "No type",
    });
    expect(result.itemType).toBeUndefined();
    expect(result.fields.publicationTitle).toBe("Mystery Source");
  });

  it("unknown type yields no itemType", () => {
    const result = mapCslToZotero({ type: "weird-type", title: "x" });
    expect(result.itemType).toBeUndefined();
    expect(result).not.toHaveProperty("itemType");
  });

  it("missing author array yields empty creators", () => {
    const result = mapCslToZotero({ type: "book", title: "x" });
    expect(result.creators).toEqual([]);
  });

  it("missing issued yields no date field", () => {
    const result = mapCslToZotero({ type: "book", title: "x" });
    expect(result.fields.date).toBeUndefined();
  });

  it("never emits empty strings and only maps present keys", () => {
    const result = mapCslToZotero(ng3834);
    expect(result.fields.publicationTitle).not.toBe("");
    expect(result.creators[0].name).not.toBe("");
    for (const value of Object.values(result.fields)) {
      expect(value).not.toBe("");
    }
  });

  it("does not mutate the input object", () => {
    const input = JSON.parse(JSON.stringify(inlineJournalArticle));
    const before = JSON.stringify(input);
    const deepFreeze = (obj: any): void => {
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (value && typeof value === "object") deepFreeze(value);
      }
      Object.freeze(obj);
    };
    deepFreeze(input);
    const result = mapCslToZotero(input);
    expect(result).toBeTruthy();
    expect(JSON.stringify(input)).toBe(before);
  });
});
