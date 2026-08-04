import { describe, expect, it } from "vitest";
import { extractDoi } from "./doi";

describe("extractDoi", () => {
  it("1. DOI field takes priority over extra", () => {
    const item = { DOI: "10.1000/priority", extra: "doi: 10.9999/extra" };
    expect(extractDoi(item)).toBe("10.1000/priority");
  });

  it("2. strips https://doi.org/ prefix from DOI field", () => {
    expect(extractDoi({ DOI: "https://doi.org/10.1000/ABC" })).toBe("10.1000/abc");
  });

  it("3. extracts DOI line from extra with surrounding lines", () => {
    const extra = ["PMID: 12345678", "Abstract: some text", "DOI: 10.1038/ng.3834", "Keywords: foo; bar"].join(
      "\n",
    );
    expect(extractDoi({ extra })).toBe("10.1038/ng.3834");
  });

  it("4. lowercases uppercase DOIs", () => {
    expect(extractDoi({ DOI: "10.1038/NG.3834" })).toBe("10.1038/ng.3834");
  });

  it("5. strips trailing punctuation", () => {
    expect(extractDoi({ DOI: "10.1000/abc.," })).toBe("10.1000/abc");
  });

  it("6. returns null for invalid inputs", () => {
    expect(extractDoi({ DOI: "abc" })).toBeNull();
    expect(extractDoi({ DOI: "10./x" })).toBeNull();
    expect(extractDoi({ DOI: "" })).toBeNull();
    expect(extractDoi({})).toBeNull();
  });

  it("7. uses only the first DOI line in extra", () => {
    const extra = "doi: 10.1038/ng.3834\ndoi: 10.1000/second";
    expect(extractDoi({ extra })).toBe("10.1038/ng.3834");
  });

  it("8. strips dx.doi.org prefix variant", () => {
    expect(extractDoi({ DOI: "https://dx.doi.org/10.1038/NG.3834;" })).toBe("10.1038/ng.3834");
  });

  it("9. decodes percent-encoded DOIs", () => {
    expect(extractDoi({ DOI: "10.1000/abc%2Fdef" })).toBe("10.1000/abc/def");
  });

  it("10. falls back to undecoded string when decodeURIComponent throws", () => {
    expect(extractDoi({ DOI: "10.1000/abc%ZZ" })).toBe("10.1000/abc%zz");
  });

  it("11. matches lowercase doi: lines with extra whitespace", () => {
    expect(extractDoi({ extra: "  doi :  10.1000/extra  " })).toBe("10.1000/extra");
  });
});
