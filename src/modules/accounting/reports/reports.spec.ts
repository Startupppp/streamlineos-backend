/**
 * Pure-logic cover for the reporting layer — the parts that do not need a
 * database and therefore have no excuse for being slow.
 *
 * The DTO cases matter more than they look: a report query that silently
 * accepts a typo'd parameter hands someone a statement for the wrong dates and
 * looks completely correct while doing it.
 */
import {
  agingQuerySchema,
  balanceSheetQuerySchema,
  profitLossQuerySchema,
  reportExportQuerySchema,
  trialBalanceQuerySchema,
} from "./dto/reports.schemas";
import { csvFilename, csvMoney, toCsv, withCsvPreamble } from "./report-csv";
import { REPORT_LABELS, label, labelPair, accountTypeLabelKey } from "./report-labels";
import { bucketFor } from "./aging.service";
import { CASH_FLOW_LIMITATIONS } from "./cash-flow.service";
import { classOf, classSigned, daysBetween, negated, normalSigned } from "./report-queries";

describe("report query DTOs", () => {
  it("accepts the PRD's routes and coerces query-string booleans", () => {
    expect(trialBalanceQuerySchema.parse({ asOf: "2026-08-25" })).toEqual({
      asOf: "2026-08-25",
      labelMode: "founder",
      format: "json",
    });

    const parsed = trialBalanceQuerySchema.parse({
      asOf: "2026-08-25",
      includeZeroActivity: "true",
      labelMode: "accountant",
      format: "csv",
    });
    expect(parsed.includeZeroActivity).toBe(true);
    expect(parsed.labelMode).toBe("accountant");

    expect(
      profitLossQuerySchema.parse({ from: "2026-04-01", to: "2027-03-31", comparative: "1" })
        .comparative,
    ).toBe(true);
    expect(
      profitLossQuerySchema.parse({ from: "2026-04-01", to: "2027-03-31", clampToFiscalYear: "0" })
        .clampToFiscalYear,
    ).toBe(false);
  });

  it("rejects a mistyped parameter rather than quietly defaulting", () => {
    // `asof` is not `asOf`. Without .strict() this would report on today.
    expect(() => trialBalanceQuerySchema.parse({ asof: "2026-08-25" })).toThrow();
    expect(() =>
      balanceSheetQuerySchema.parse({ asOf: "2026-08-25", includeZeros: "true" }),
    ).toThrow();
    expect(() => balanceSheetQuerySchema.parse({ asOf: "25/08/2026" })).toThrow();
    expect(() => balanceSheetQuerySchema.parse({ asOf: "2026-8-5" })).toThrow();
    expect(() => agingQuerySchema.parse({ side: "gl", asOf: "2026-08-25" })).toThrow();
  });

  it("defaults ageing to the due date, which is the collections question", () => {
    expect(agingQuerySchema.parse({ side: "ar", asOf: "2026-08-25" }).basis).toBe("due");
    expect(
      agingQuerySchema.parse({ side: "ap", asOf: "2026-08-25", basis: "issue" }).basis,
    ).toBe("issue");
  });

  it("routes each export to its own parameter set", () => {
    const tb = reportExportQuerySchema.parse({ report: "trial-balance", asOf: "2026-08-25" });
    expect(tb).toMatchObject({ report: "trial-balance", asOf: "2026-08-25" });

    const aging = reportExportQuerySchema.parse({
      report: "aging",
      side: "ap",
      asOf: "2026-08-25",
    });
    expect(aging).toMatchObject({ report: "aging", side: "ap", basis: "due" });

    // A trial balance has no `side`, and asking for one is a mistake worth surfacing.
    expect(() =>
      reportExportQuerySchema.parse({ report: "trial-balance", asOf: "2026-08-25", side: "ar" }),
    ).toThrow();
    // And the date range the report actually needs is still required.
    expect(() => reportExportQuerySchema.parse({ report: "pnl", asOf: "2026-08-25" })).toThrow();
    expect(() => reportExportQuerySchema.parse({ report: "nonsense" })).toThrow();
  });
});

describe("account taxonomy", () => {
  it("folds contra types into the class they reduce", () => {
    expect(classOf("CONTRA_ASSET")).toBe("ASSET");
    expect(classOf("CONTRA_LIABILITY")).toBe("LIABILITY");
    expect(classOf("EXPENSE")).toBe("EXPENSE");
  });

  it("signs a contra account negative inside its own section", () => {
    // Accumulated depreciation holds a credit; it is a negative asset.
    expect(classSigned("CONTRA_ASSET", 0, 100)).toBe(-100);
    // …but its own normal balance is still positive on the credit side.
    expect(normalSigned("CONTRA_ASSET", 0, 100)).toBe(100);

    expect(classSigned("ASSET", 100, 0)).toBe(100);
    expect(classSigned("LIABILITY", 0, 100)).toBe(100);
    expect(classSigned("CONTRA_LIABILITY", 100, 0)).toBe(-100);
    expect(classSigned("INCOME", 0, 100)).toBe(100);
    expect(classSigned("EXPENSE", 100, 0)).toBe(100);
  });

  it("never produces negative zero", () => {
    expect(Object.is(negated(0), 0)).toBe(true);
    expect(negated(5)).toBe(-5);
    expect(negated(-5)).toBe(5);
  });
});

describe("date arithmetic", () => {
  it("counts whole days in UTC, across a month and a leap day", () => {
    expect(daysBetween("2026-07-17", "2026-08-31")).toBe(45);
    expect(daysBetween("2026-08-31", "2026-08-31")).toBe(0);
    expect(daysBetween("2026-09-01", "2026-08-31")).toBe(-1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2025-04-01", "2026-03-31")).toBe(364);
  });

  it("buckets on the boundaries the PRD names", () => {
    expect(bucketFor(-5)).toBe("0-30");
    expect(bucketFor(30)).toBe("0-30");
    expect(bucketFor(31)).toBe("31-60");
    expect(bucketFor(60)).toBe("31-60");
    expect(bucketFor(61)).toBe("61-90");
    expect(bucketFor(90)).toBe("61-90");
    expect(bucketFor(91)).toBe("91+");
  });
});

describe("labels", () => {
  it("gives every key both a founder and an accountant wording", () => {
    for (const [key, pair] of Object.entries(REPORT_LABELS)) {
      expect(pair.founder.trim().length).toBeGreaterThan(0);
      expect(pair.accountant.trim().length).toBeGreaterThan(0);
      expect(label(key as keyof typeof REPORT_LABELS, "founder")).toBe(pair.founder);
      expect(label(key as keyof typeof REPORT_LABELS, "accountant")).toBe(pair.accountant);
    }
  });

  it("says what the PRD asks a founder to see", () => {
    expect(labelPair("section.income").founder).toBe("Money in");
    expect(labelPair("section.expense").founder).toBe("Money out");
    expect(labelPair("section.assets").founder).toBe("What we own");
    expect(labelPair("section.liabilities").founder).toBe("What we owe");
    expect(labelPair("report.aging_ar").founder).toBe("What customers owe us");
    expect(labelPair("report.aging_ar").accountant).toBe("Accounts receivable ageing");
  });

  it("has a label for every account type the kernel can produce", () => {
    for (const t of [
      "ASSET",
      "CONTRA_ASSET",
      "LIABILITY",
      "CONTRA_LIABILITY",
      "EQUITY",
      "INCOME",
      "EXPENSE",
    ] as const) {
      expect(REPORT_LABELS[accountTypeLabelKey(t)]).toBeDefined();
    }
  });
});

describe("CSV rendering", () => {
  it("quotes separators and newlines instead of shifting columns", () => {
    const csv = toCsv(["a", "b"], [["Smith, Jones & Co", 'He said "hi"'], ["line\nbreak", 1]]);
    expect(csv).toContain('"Smith, Jones & Co"');
    expect(csv).toContain('"He said ""hi"""');
    expect(csv).toContain('"line\nbreak"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("defuses a formula in tenant-supplied text but not in a negative number", () => {
    const csv = toCsv(["v"], [["=SUM(A1:A9)"], ["@import"], ["-1234"], [-1234]]);
    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).toContain("'@import");
    // A string starting "-" is still guarded…
    expect(csv).toContain("'-1234");
    // …but a real number is left alone, so a credit balance reads normally.
    expect(csv).toContain("\r\n-1234\r\n");
  });

  it("renders money as a decimal string a spreadsheet can sum", () => {
    expect(csvMoney(10_590_000, "INR")).toBe("105900.00");
    expect(csvMoney(-90_000, "INR")).toBe("-900.00");
    expect(csvMoney(0, "USD")).toBe("0.00");
    // Zero-decimal currency: no phantom minor units.
    expect(csvMoney(1234, "JPY")).toBe("1234");
  });

  it("keeps the preamble separate from the table", () => {
    const out = withCsvPreamble(
      [
        ["Report", "Balance sheet"],
        ["As of", "2026-08-25"],
      ],
      toCsv(["x"], [["1"]]),
    );
    expect(out.startsWith("Report,Balance sheet\r\nAs of,2026-08-25\r\n\r\nx\r\n")).toBe(true);
  });

  it("builds a filesystem-safe filename", () => {
    expect(csvFilename(["trial-balance", "2026-08-25"])).toBe("trial-balance-2026-08-25.csv");
    // No input can contribute a `..` segment or a second extension.
    expect(csvFilename(["../../etc/passwd"])).toBe("etc-passwd.csv");
    expect(csvFilename(["report.csv.exe"])).toBe("report-csv-exe.csv");
    expect(csvFilename([])).toBe("report.csv");
  });
});

describe("cash flow honesty", () => {
  it("ships a non-empty list of what it does not model", () => {
    expect(CASH_FLOW_LIMITATIONS.length).toBeGreaterThanOrEqual(5);
    for (const limitation of CASH_FLOW_LIMITATIONS) {
      expect(limitation.trim().length).toBeGreaterThan(20);
    }
    const all = CASH_FLOW_LIMITATIONS.join(" ");
    expect(all).toMatch(/investing/i);
    expect(all).toMatch(/inventory/i);
    expect(all).toMatch(/depreciation/i);
    expect(all).toMatch(/exchange/i);
  });
});
