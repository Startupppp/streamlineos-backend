/**
 * The pure half of the statement importer. No database, so these are the tests
 * that can be run on every keystroke — and the edge cases PRD 04 names all live
 * here rather than behind an HTTP call.
 */
import {
  assertMappingIsUsable,
  findDuplicateLines,
  parseAmountToMinor,
  parseCsv,
  parseStatementCsv,
  parseStatementDate,
  StatementCsvError,
  SUPPORTED_DATE_FORMATS,
} from "./statement-csv";
import { STATEMENT_MAPPING_PRESETS, findMappingPreset } from "./csv-presets";

describe("parseStatementDate", () => {
  it("reads the same string two different ways, because the caller chose", () => {
    expect(parseStatementDate("03/04/2026", "DD/MM/YYYY")).toBe("2026-04-03");
    expect(parseStatementDate("03/04/2026", "MM/DD/YYYY")).toBe("2026-03-04");
  });

  it("handles the other layouts banks actually export", () => {
    expect(parseStatementDate("2026-04-03", "YYYY-MM-DD")).toBe("2026-04-03");
    expect(parseStatementDate("3-Apr-2026", "DD-MMM-YYYY")).toBe("2026-04-03");
    expect(parseStatementDate("Apr 3, 2026", "MMM DD, YYYY")).toBe("2026-04-03");
    expect(parseStatementDate("03.04.2026", "DD.MM.YYYY")).toBe("2026-04-03");
  });

  it("drops a trailing clock reading", () => {
    expect(parseStatementDate("2026-04-03 10:22:00", "YYYY-MM-DD")).toBe("2026-04-03");
    expect(parseStatementDate("04/03/2026 11:15 PM", "MM/DD/YYYY")).toBe("2026-04-03");
  });

  it("refuses a date the declared format cannot describe", () => {
    expect(() => parseStatementDate("2026-04-03", "DD/MM/YYYY")).toThrow(/is not a DD\/MM\/YYYY date/);
    expect(() => parseStatementDate("31/04/2026", "DD/MM/YYYY")).toThrow(/not a real calendar date/);
    expect(() => parseStatementDate("13/04/2026", "MM/DD/YYYY")).toThrow(/not a real calendar date/);
  });

  it("offers no two-digit-year layout at all", () => {
    expect(SUPPORTED_DATE_FORMATS.some((f) => /(^|[^Y])YY([^Y]|$)/.test(f))).toBe(false);
  });
});

describe("parseAmountToMinor", () => {
  it("reads the shapes exports use", () => {
    expect(parseAmountToMinor("500.00", "INR")).toBe(50_000);
    expect(parseAmountToMinor("1,234.56", "USD")).toBe(123_456);
    expect(parseAmountToMinor("1,00,000.00", "INR")).toBe(10_000_000);
    expect(parseAmountToMinor("₹1,00,000.00", "INR")).toBe(10_000_000);
    expect(parseAmountToMinor("-200", "USD")).toBe(-20_000);
    expect(parseAmountToMinor("(200.00)", "USD")).toBe(-20_000);
    expect(parseAmountToMinor("500.00 CR", "USD")).toBe(50_000);
    expect(parseAmountToMinor("500.00 DR", "USD")).toBe(-50_000);
    expect(parseAmountToMinor("INR 42.00", "INR")).toBe(4_200);
    expect(parseAmountToMinor("1.234,56", "EUR", ",")).toBe(123_456);
  });

  it("honours the currency's own scale", () => {
    expect(parseAmountToMinor("1200", "JPY")).toBe(1_200);
    expect(parseAmountToMinor("1.234", "KWD")).toBe(1_234);
    expect(() => parseAmountToMinor("1.23", "JPY")).toThrow(/decimal places/);
  });

  it("returns null for a blank cell rather than zero", () => {
    expect(parseAmountToMinor("", "INR")).toBeNull();
    expect(parseAmountToMinor("   ", "INR")).toBeNull();
  });

  it("refuses anything that is not a clean decimal", () => {
    for (const bad of ["12abc", "1.2.3", "1,,2", ",12", "12,", "abc", "--5", "1 2 3.4.5"]) {
      expect(() => parseAmountToMinor(bad, "INR")).toThrow(StatementCsvError);
    }
    expect(() => parseAmountToMinor("100.005", "INR")).toThrow(/decimal places/);
  });
});

describe("parseCsv", () => {
  it("handles quotes, embedded delimiters, newlines and CRLF", () => {
    const grid = parseCsv('a,b\r\n"x,1","y\nz"\r\n"say ""hi""",2\r\n');
    expect(grid).toEqual([
      ["a", "b"],
      ["x,1", "y\nz"],
      ['say "hi"', "2"],
    ]);
  });

  it("strips a BOM and supports another delimiter", () => {
    expect(parseCsv("﻿a;b\n1;2", ";")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("refuses a file that ends inside a quoted field", () => {
    expect(() => parseCsv('a,b\n"unterminated,2')).toThrow(/inside a quoted field/);
  });
});

describe("assertMappingIsUsable", () => {
  it("refuses a mapping with no date format, and says why it matters", () => {
    expect(() => assertMappingIsUsable({ dateColumn: "Date", amountColumn: "Amount" })).toThrow(
      /must declare its date format/,
    );
    expect(() => assertMappingIsUsable({ dateColumn: "Date", amountColumn: "Amount" })).toThrow(
      /3 April under DD\/MM\/YYYY and 4 March under MM\/DD\/YYYY/,
    );
  });

  it("refuses an unknown format, a missing date column and an ambiguous amount", () => {
    expect(() =>
      assertMappingIsUsable({ dateColumn: "Date", amountColumn: "Amount", dateFormat: "DD/MM/YY" }),
    ).toThrow(/Unsupported date format/);
    expect(() => assertMappingIsUsable({ amountColumn: "Amount", dateFormat: "DD/MM/YYYY" })).toThrow(
      /name the date column/,
    );
    expect(() => assertMappingIsUsable({ dateColumn: "Date", dateFormat: "DD/MM/YYYY" })).toThrow(
      /either an amount column or a debit\/credit pair/,
    );
    expect(() =>
      assertMappingIsUsable({
        dateColumn: "Date",
        amountColumn: "Amount",
        debitColumn: "Withdrawal",
        dateFormat: "DD/MM/YYYY",
      }),
    ).toThrow(/not both/);
  });
});

describe("parseStatementCsv", () => {
  const inPreset = findMappingPreset("IN_NARRATION_WITHDRAWAL_DEPOSIT")!.mapping;

  it("signs a withdrawal negative and a deposit positive", () => {
    const parsed = parseStatementCsv(
      [
        "Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.",
        "05/04/2026,UPI-ACME,UTR9911,,500.00",
        "12/04/2026,NEFT DR,NEFT4477,200.00,",
      ].join("\n"),
      inPreset,
      "INR",
    );

    expect(parsed.rows.map((r) => [r.valueDate, r.amountMinor])).toEqual([
      ["2026-04-05", 50_000],
      ["2026-04-12", -20_000],
    ]);
    expect(parsed.rows[0].bankReference).toBe("UTR9911");
  });

  it("refuses a row carrying both a withdrawal and a deposit", () => {
    expect(() =>
      parseStatementCsv(
        [
          "Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.",
          "05/04/2026,BOTH,UTR1,100.00,200.00",
        ].join("\n"),
        inPreset,
        "INR",
      ),
    ).toThrow(/both a withdrawal and a deposit/);
  });

  it("matches headers case- and whitespace-insensitively, and names a missing one", () => {
    const parsed = parseStatementCsv(
      ["  DATE , description , amount ", "04/03/2026,Row,10.00"].join("\n"),
      { dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "MM/DD/YYYY" },
      "USD",
    );
    expect(parsed.rows[0].valueDate).toBe("2026-04-03");

    expect(() =>
      parseStatementCsv(
        ["Date,Description", "04/03/2026,Row"].join("\n"),
        { dateColumn: "Date", amountColumn: "Amount", dateFormat: "MM/DD/YYYY" },
        "USD",
      ),
    ).toThrow(/no column named "Amount"/);
  });

  it("skips preamble rows and reports rows with no movement rather than hiding them", () => {
    const parsed = parseStatementCsv(
      [
        "Statement for account 000123456789",
        "Date,Description,Amount",
        "04/03/2026,Real movement,10.00",
        "04/04/2026,Balance carried forward,0.00",
        ",No date at all,5.00",
        "",
      ].join("\n"),
      { dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "MM/DD/YYYY", skipRows: 1 },
      "USD",
    );

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.skipped.map((s) => s.reason)).toEqual(["no movement on the row", "no date"]);
  });

  it("numbers lines from one, independent of the source row", () => {
    const parsed = parseStatementCsv(
      ["Date,Description,Amount", "04/03/2026,Zero,0.00", "04/04/2026,Real,10.00"].join("\n"),
      { dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "MM/DD/YYYY" },
      "USD",
    );
    expect(parsed.rows.map((r) => [r.lineNo, r.sourceRowNumber])).toEqual([[1, 3]]);
  });
});

describe("findDuplicateLines", () => {
  const row = (lineNo: number, valueDate: string, amountMinor: number, bankReference: string | null) => ({
    lineNo,
    sourceRowNumber: lineNo + 1,
    valueDate,
    amountMinor,
    bankReference,
    description: null,
    rawRow: {},
  });

  it("groups identical date/amount/reference triples and leaves everything else alone", () => {
    const groups = findDuplicateLines([
      row(1, "2026-04-05", 50_000, "UTR7777"),
      row(2, "2026-04-05", 50_000, "UTR7777"),
      row(3, "2026-04-05", 50_000, "UTR8888"),
      row(4, "2026-04-06", 50_000, "UTR7777"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].lineNos).toEqual([1, 2]);
  });

  it("reports rather than removes — the caller decides", () => {
    const rows = [row(1, "2026-04-05", 50_000, null), row(2, "2026-04-05", 50_000, null)];
    expect(findDuplicateLines(rows)).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });
});

describe("mapping presets", () => {
  it("ships the India, US and neobank layouts, and every one of them is valid", () => {
    const codes = STATEMENT_MAPPING_PRESETS.map((p) => p.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "IN_NARRATION_WITHDRAWAL_DEPOSIT",
        "US_QBO_THREE_COLUMN",
        "WISE_MERCURY_SIGNED",
      ]),
    );
    for (const preset of STATEMENT_MAPPING_PRESETS) {
      expect(() => assertMappingIsUsable(preset.mapping)).not.toThrow();
    }
  });

  it("is data — the India and US presets differ only in columns and date order", () => {
    expect(findMappingPreset("IN_NARRATION_WITHDRAWAL_DEPOSIT")?.mapping.dateFormat).toBe("DD/MM/YYYY");
    expect(findMappingPreset("US_QBO_THREE_COLUMN")?.mapping.dateFormat).toBe("MM/DD/YYYY");
    expect(findMappingPreset("NOPE")).toBeUndefined();
  });
});
