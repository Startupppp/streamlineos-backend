import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { ExpensesImportService } from "./expenses-import.service";

const HEADER = "category,amount,description,merchant,expensedate";

async function importCsv(body: string, categoryMapping?: Record<string, string>) {
  const inserted: Array<{ category: string }> = [];
  // `useValue` is untyped, so the capture needs no cast to `Db`.
  const db = {
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

  it("files a blank category as Other, the documented default", async () => {
    const { categories } = await importCsv(",10,Taxi,Cab Co,2026-01-05");
    expect(categories).toEqual(["Other"]);
  });
});
