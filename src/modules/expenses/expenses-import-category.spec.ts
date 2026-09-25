import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { ExpensesImportService } from "./expenses-import.service";

const HEADER = "category,amount,description,merchant,expensedate";

async function importCsv(body: string, categoryMapping?: Record<string, string>) {
  const inserted: Array<{ category: string }> = [];
  // `useValue` is untyped, so the capture needs no cast to `Db`.
  const db = {
    // no expense is already on file in these cases; the duplicate pass reads nothing.
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({
      values: (rows: Array<{ category: string }>) => {
        inserted.push(...rows);
        return Promise.resolve([]);
      },
    }),
  };
  const module = await Test.createTestingModule({
    providers: [ExpensesImportService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  const result = await module.get(ExpensesImportService).importExpenses("org-1", "user-1", {
    fileName: "expenses.csv",
    content: `${HEADER}\n${body}`,
    ...(categoryMapping ? { categoryMapping } : {}),
  });
  return { result, categories: inserted.map((row) => row.category) };
}

describe("expense import — a category is never silently rewritten (HRMS-E2E-008)", () => {
  it("keeps a known category", async () => {
    const { categories } = await importCsv("Travel,10,Taxi,Cab Co,2026-01-05");
    expect(categories).toEqual(["Travel"]);
  });

  it("matches a known category regardless of case, as the import preview already promises", async () => {
    const { categories } = await importCsv("travel,10,Taxi,Cab Co,2026-01-05");
    expect(categories).toEqual(["Travel"]);
  });

  it("applies the mapping the person chose in the preview", async () => {
    const { categories, result } = await importCsv("Flights,10,Air,Airline,2026-01-05", { Flights: "Travel" });
    expect(categories).toEqual(["Travel"]);
    expect(result.skipped).toBe(0);
  });

  it("skips an unknown, unmapped category with a reason instead of filing it as Other", async () => {
    const { categories, result } = await importCsv("Flights,10,Air,Airline,2026-01-05");
    expect(categories).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons[0]?.reason).toMatch(/Unknown category "Flights"/);
  });

  it("refuses a mapping onto a category that is not allowed", async () => {
    const { categories, result } = await importCsv("Flights,10,Air,Airline,2026-01-05", { Flights: "Yachts" });
    expect(categories).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("maps Meals onto Food through the alias map instead of erroring", async () => {
    const { categories, result } = await importCsv("Meals,10,Team lunch,Cafe,2026-01-05");
    expect(categories).toEqual(["Food"]);
    expect(result.skipped).toBe(0);
    expect(result.skippedReasons).toEqual([]);
  });

  it("maps an alias regardless of case and surrounding space", async () => {
    const { categories } = await importCsv("  DINING ,10,Team dinner,Cafe,2026-01-05");
    expect(categories).toEqual(["Food"]);
  });

  it("still makes a genuinely unknown category a row error, alias map or not", async () => {
    const { categories, result } = await importCsv("Cryptocurrency,10,Coins,Exchange,2026-01-05");
    expect(categories).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons[0]).toMatchObject({ row: 2 });
    expect(result.skippedReasons[0]?.reason).toMatch(
      /Unknown category "Cryptocurrency"\. Use one of: /,
    );
  });

  it("files a blank category as Other, the documented default", async () => {
    const { categories } = await importCsv(",10,Taxi,Cab Co,2026-01-05");
    expect(categories).toEqual(["Other"]);
  });
});
