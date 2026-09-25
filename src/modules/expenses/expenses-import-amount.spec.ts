import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { type Db } from "../../db/drizzle.module";
import { ExpensesImportService } from "./expenses-import.service";

const HEADER = "category,amount,description,merchant,expensedate";

interface InsertedExpense {
  amount: string;
  description: string;
}

// Captures the rows the importer actually hands the database, which is where a wrong amount lands.
function makeCapturingDb(): { db: Db; inserted: InsertedExpense[] } {
  const inserted: InsertedExpense[] = [];
  const db = {
    // no expense is already on file in these cases; the duplicate pass reads nothing.
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert() {
      return {
        values(rows: InsertedExpense[]) {
          inserted.push(...rows);
          return Promise.resolve([]);
        },
      };
    },
  } as unknown as Db;
  return { db, inserted };
}

async function importCsv(body: string) {
  const { db, inserted } = makeCapturingDb();
  const module = await Test.createTestingModule({
    providers: [ExpensesImportService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  const service = module.get(ExpensesImportService);

  const result = await service.importExpenses("org-1", "user-1", {
    fileName: "expenses.csv",
    content: `${HEADER}\n${body}`,
  });
  return { result, inserted };
}

describe("expense import — a cell that is not a clean decimal is refused, never guessed", () => {
  it("imports a thousands-separated amount at its real value", async () => {
    const { result, inserted } = await importCsv('Travel,"1,234.50",Flight,Airline,2026-01-05');

    expect(result.count).toBe(1);
    expect(result.skipped).toBe(0);
    expect(Number(inserted[0].amount)).toBe(1234.5);
  });

  it("imports a plain decimal unchanged", async () => {
    const { inserted } = await importCsv("Travel,899.99,Taxi,Cab Co,2026-01-05");

    expect(Number(inserted[0].amount)).toBe(899.99);
  });

  it("skips a cell with a trailing token instead of importing the leading digits", async () => {
    const { result, inserted } = await importCsv("Travel,500abc,Taxi,Cab Co,2026-01-05");

    expect(inserted).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons[0].reason).toContain("Invalid amount");
  });

  it("skips a cell with two decimal points instead of importing the first number", async () => {
    const { result, inserted } = await importCsv("Travel,1.2.3,Taxi,Cab Co,2026-01-05");

    expect(inserted).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("skips scientific notation rather than expanding it", async () => {
    const { result, inserted } = await importCsv("Travel,1e3,Taxi,Cab Co,2026-01-05");

    expect(inserted).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("skips a zero amount", async () => {
    const { result, inserted } = await importCsv("Travel,0.00,Taxi,Cab Co,2026-01-05");

    expect(inserted).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("skips an amount over the ceiling", async () => {
    const { result, inserted } = await importCsv("Travel,100000000.01,Taxi,Cab Co,2026-01-05");

    expect(inserted).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("keeps the amount at the ceiling", async () => {
    const { inserted } = await importCsv("Travel,100000000,Taxi,Cab Co,2026-01-05");

    expect(Number(inserted[0].amount)).toBe(100_000_000);
  });

  it("reports the skipped row number so the tenant can fix that line", async () => {
    const { result } = await importCsv(
      ["Travel,10.00,Ok,M,2026-01-05", "Travel,not-a-number,Bad,M,2026-01-05"].join("\n"),
    );

    expect(result.count).toBe(1);
    expect(result.skippedReasons).toEqual([
      { row: 3, reason: expect.stringContaining("Invalid amount") },
    ]);
  });
});
