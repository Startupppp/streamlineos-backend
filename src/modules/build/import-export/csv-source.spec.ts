import { isBlankCsvRow, parseCsvRows, toCsv } from "./csv-source";

const BOM = String.fromCharCode(0xfeff);

describe("parseCsvRows", () => {
  it("splits plain comma separated rows", () => {
    expect(parseCsvRows("title,status\nOne,TODO")).toEqual([
      ["title", "status"],
      ["One", "TODO"],
    ]);
  });

  it("treats CRLF as a single row break", () => {
    expect(parseCsvRows("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps commas and newlines inside quoted fields", () => {
    expect(parseCsvRows('title\n"One, two\nthree"')).toEqual([["title"], ["One, two\nthree"]]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsvRows('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("strips a leading byte order mark from the first header", () => {
    expect(parseCsvRows(BOM + "title,status\nOne,TODO")[0]).toEqual(["title", "status"]);
  });

  it("keeps a quoted empty field distinct from a missing trailing row", () => {
    expect(parseCsvRows('a,b\n"",x\n')).toEqual([
      ["a", "b"],
      ["", "x"],
    ]);
  });

  it("does not emit a trailing empty row for a file ending in a newline", () => {
    expect(parseCsvRows("a\nb\n")).toHaveLength(2);
  });
});

describe("isBlankCsvRow", () => {
  it("is true for a row of empty and whitespace cells", () => {
    expect(isBlankCsvRow(["", "   "])).toBe(true);
  });

  it("is false when any cell has content", () => {
    expect(isBlankCsvRow(["", "x"])).toBe(false);
  });
});

describe("toCsv", () => {
  it("quotes only the cells that need it", () => {
    expect(toCsv([["a", "b,c"]])).toBe('a,"b,c"');
  });

  it("round trips values containing quotes, commas and newlines", () => {
    const original = [
      ["title", "description"],
      ['He said "go"', "line one\nline two"],
      ["plain", "a,b"],
    ];
    expect(parseCsvRows(toCsv(original))).toEqual(original);
  });
});
