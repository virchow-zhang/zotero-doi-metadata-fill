import { describe, expect, it } from "vitest";
import { computeChanges, type Changes, type Mapped, type Snapshot } from "./fill-policy";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    itemType: "journalArticle",
    fields: {},
    creators: [],
    ...overrides,
  };
}

function mapped(overrides: Partial<Mapped> = {}): Mapped {
  return {
    fields: {},
    creators: [],
    ...overrides,
  };
}

describe("computeChanges", () => {
  it("fills only empty fields; never touches non-empty existing fields", () => {
    const s = snapshot({
      fields: { title: "Old Title", year: "2023", date: "" },
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const m = mapped({
      fields: { title: "New Title", year: "2024", date: "2023-05-01", abstract: "An abstract" },
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const changes = computeChanges(s, m);
    expect(changes.fieldsToSet).toEqual({ date: "2023-05-01", abstract: "An abstract" });
    expect(changes.fieldsToSet.title).toBeUndefined();
    expect(changes.fieldsToSet.year).toBeUndefined();
  });

  it("zero snapshot authors -> set: mapped authors first, existing non-author creators kept at end", () => {
    const s = snapshot({
      creators: [{ creatorType: "editor", lastName: "Jones" }],
    });
    const m = mapped({
      creators: [
        { creatorType: "author", firstName: "Jane", lastName: "Doe" },
        { creatorType: "author", lastName: "Roe" },
      ],
    });
    const changes = computeChanges(s, m);
    expect(changes.creatorsAction).toBe("set");
    expect(changes.newCreators).toEqual([
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      { creatorType: "author", lastName: "Roe" },
      { creatorType: "editor", lastName: "Jones" },
    ]);
  });

  it("R4: longer mapped list where EVERY existing surname matches -> set", () => {
    const s = snapshot({
      creators: [
        { creatorType: "author", lastName: "Smith" },
        { creatorType: "author", lastName: "Brown" },
      ],
    });
    const m = mapped({
      creators: [
        { creatorType: "author", firstName: "Adam", lastName: "Smith" },
        { creatorType: "author", lastName: "Brown" },
        { creatorType: "author", lastName: "Chen" },
      ],
    });
    const changes = computeChanges(s, m);
    expect(changes.creatorsAction).toBe("set");
    expect(changes.newCreators).toHaveLength(3);
    expect(changes.newCreators?.[0]).toEqual({
      creatorType: "author",
      firstName: "Adam",
      lastName: "Smith",
    });
  });

  it("R4: longer mapped list with only ONE of two existing surnames matching -> none", () => {
    const s = snapshot({
      creators: [
        { creatorType: "author", lastName: "Smith" },
        { creatorType: "author", lastName: "Brown" },
      ],
    });
    const m = mapped({
      creators: [
        { creatorType: "author", firstName: "John", lastName: "Smith" },
        { creatorType: "author", lastName: "Doe" },
        { creatorType: "author", lastName: "Roe" },
      ],
    });
    const changes = computeChanges(s, m);
    expect(changes.creatorsAction).toBe("none");
    expect(changes.newCreators).toBeUndefined();
  });

  it("mapped authors strictly longer but NO surname match -> none", () => {
    const s = snapshot({
      creators: [
        { creatorType: "author", lastName: "Smith" },
        { creatorType: "author", lastName: "Brown" },
      ],
    });
    const m = mapped({
      creators: [
        { creatorType: "author", lastName: "Doe" },
        { creatorType: "author", lastName: "Roe" },
        { creatorType: "author", lastName: "Chen" },
      ],
    });
    const changes = computeChanges(s, m);
    expect(changes.creatorsAction).toBe("none");
    expect(changes.newCreators).toBeUndefined();
  });

  it("equal-length author lists with surname match -> none", () => {
    const s = snapshot({
      creators: [
        { creatorType: "author", lastName: "Smith" },
        { creatorType: "author", lastName: "Brown" },
      ],
    });
    const m = mapped({
      creators: [
        { creatorType: "author", firstName: "John", lastName: "Smith" },
        { creatorType: "author", lastName: "Brown" },
      ],
    });
    const changes = computeChanges(s, m);
    expect(changes.creatorsAction).toBe("none");
    expect(changes.newCreators).toBeUndefined();
  });

  it("non-author-only snapshot (e.g. editors only) counts as zero authors -> set", () => {
    const s = snapshot({
      creators: [
        { creatorType: "editor", lastName: "Jones" },
        { creatorType: "editor", lastName: "Lee" },
      ],
    });
    const m = mapped({
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const changes = computeChanges(s, m);
    expect(changes.creatorsAction).toBe("set");
    expect(changes.newCreators).toEqual([
      { creatorType: "author", lastName: "Smith" },
      { creatorType: "editor", lastName: "Jones" },
      { creatorType: "editor", lastName: "Lee" },
    ]);
  });

  it("webpage -> journalArticle proposed; webpage -> thesis not proposed", () => {
    const author = { creatorType: "author", lastName: "Smith" } as const;
    const base = snapshot({ itemType: "webpage", creators: [author] });
    const toArticle = computeChanges(base, mapped({ itemType: "journalArticle" }));
    expect(toArticle.itemTypeTo).toBe("journalArticle");
    const toThesis = computeChanges(base, mapped({ itemType: "thesis" }));
    expect(toThesis.itemTypeTo).toBeUndefined();
  });

  it("journalArticle -> journalArticle: no itemType proposal (no downgrade path)", () => {
    const s = snapshot({
      itemType: "journalArticle",
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const changes = computeChanges(s, mapped({ itemType: "journalArticle" }));
    expect(changes.itemTypeTo).toBeUndefined();
    expect(Object.keys(changes)).not.toContain("itemTypeTo");
  });

  it("preprint -> conferencePaper proposed", () => {
    const s = snapshot({
      itemType: "preprint",
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const changes = computeChanges(s, mapped({ itemType: "conferencePaper" }));
    expect(changes.itemTypeTo).toBe("conferencePaper");
  });

  it("empty mapped -> empty decision, nothing proposed", () => {
    const s = snapshot({
      itemType: "webpage",
      fields: { title: "Old" },
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const changes = computeChanges(s, mapped());
    expect(changes).toEqual({ fieldsToSet: {}, creatorsAction: "none" });
    expect(Object.keys(changes)).toEqual(["fieldsToSet", "creatorsAction"]);
  });

  it("empty DOI in snapshot + DOI in mapped -> DOI included in fieldsToSet once", () => {
    const s = snapshot({
      fields: { DOI: "" },
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const m = mapped({
      fields: { DOI: "10.1000/xyz", abstract: "Abs" },
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const changes = computeChanges(s, m);
    expect(changes.fieldsToSet.DOI).toBe("10.1000/xyz");
    expect(Object.keys(changes.fieldsToSet).filter((k) => k === "DOI")).toHaveLength(1);
  });

  it("fieldsToSet never contains a key whose snapshot value is non-empty (e.g. '2023')", () => {
    const s = snapshot({
      fields: { year: "2023", title: "" },
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const m = mapped({
      fields: { year: "2024", title: "New Title" },
      creators: [{ creatorType: "author", lastName: "Smith" }],
    });
    const changes = computeChanges(s, m);
    expect(changes.fieldsToSet).toEqual({ title: "New Title" });
    expect(changes.fieldsToSet.year).toBeUndefined();
  });

  it("does not mutate inputs", () => {
    const s: Snapshot = snapshot({
      itemType: "preprint",
      fields: { title: "Old", DOI: "" },
      creators: [
        { creatorType: "author", lastName: "Smith" },
        { creatorType: "editor", lastName: "Jones" },
      ],
    });
    const m: Mapped = mapped({
      itemType: "journalArticle",
      fields: { DOI: "10.1/x", abstract: "Abs" },
      creators: [
        { creatorType: "author", firstName: "John", lastName: "Smith" },
        { creatorType: "author", lastName: "Chen" },
      ],
    });
    const before = JSON.stringify({ s, m });
    computeChanges(s, m);
    expect(JSON.stringify({ s, m })).toBe(before);
  });
});
