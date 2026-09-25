import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { ExpensesImportService } from "./expenses-import.service";

const HEADER = "category,amount,description,merchant,expenseDate";
const ROW = "Food,450.00,Team lunch,City  Cafe,2026-01-05";

/** The literals a drizzle WHERE tree binds, without walking into the table columns. */
function boundValues(node: unknown, seen = new Set<object>()): unknown[] {
  if (typeof node === "string" || typeof node === "number") return [node];
  if (Array.isArray(node)) return node.flatMap((item) => boundValues(item, seen));
  if (node === null || typeof node !== "object" || seen.has(node)) return [];
  seen.add(node);
  const record = node as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? boundValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? boundValues(record.value, seen)
      : []),
  ];
}

interface PersistedExpense {
  id: number;
  userId: string;
  expenseDate: string;
  amount: string;
  category: string;
  merchant: string | null;
}

async function importCsv(
  body: string,
  options: { confirmDuplicates?: boolean; persisted?: PersistedExpense[] } = {},
) {
  const inserted: Array<Record<string, unknown>> = [];
  let selectedWhere: unknown = null;
  // `useValue` is untyped, so the capture needs no cast to `Db`.
  const db = {
    select: () => ({
      from: () => ({
        where: (clause: unknown) => {
          selectedWhere = clause;
          return Promise.resolve(options.persisted ?? []);
        },
      }),
    }),
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => {
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
    ...(options.confirmDuplicates !== undefined
      ? { confirmDuplicates: options.confirmDuplicates }
      : {}),
  });
  return { result, inserted, selectedWhere };
}

describe("expense import — a duplicate row is never filed silently (V-070b)", () => {
  it("warns on a second row with the same employee, date, amount, category and normalized merchant and does not insert it without confirmation", async () => {
    // Second row differs only in merchant casing and spacing, which is not a difference.
    const { result, inserted } = await importCsv(
      `${ROW}\nFood,450,Team lunch,city cafe,2026-01-05`,
    );

    expect(inserted).toHaveLength(1);
    expect(result.count).toBe(1);
    expect(result.duplicateWarnings).toEqual([{ row: 3, matchesRow: 2, inserted: false }]);
    // The duplicate is reported, not counted as a parse failure.
    expect(result.skipped).toBe(0);
  });

  it("inserts both when the caller confirms", async () => {
    const { result, inserted } = await importCsv(
      `${ROW}\nFood,450,Team lunch,city cafe,2026-01-05`,
      { confirmDuplicates: true },
    );

    expect(inserted).toHaveLength(2);
    expect(result.count).toBe(2);
    expect(result.duplicateWarnings).toEqual([{ row: 3, matchesRow: 2, inserted: true }]);
  });

  it("warns against an expense the org already holds, naming the expense id", async () => {
    const { result, inserted } = await importCsv(ROW, {
      persisted: [
        {
          id: 77,
          userId: "user-1",
          expenseDate: "2026-01-05",
          amount: "450.00",
          category: "Food",
          merchant: "City Cafe",
        },
      ],
    });

    expect(inserted).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.duplicateWarnings).toEqual([{ row: 2, matchesExpenseId: 77, inserted: false }]);
  });

  it("leaves a row that differs in any key field alone", async () => {
    const { result, inserted } = await importCsv(
      [
        ROW,
        "Food,451.00,Team lunch,City Cafe,2026-01-05", // different amount
        "Food,450.00,Team lunch,City Cafe,2026-01-06", // different date
        "Travel,450.00,Team lunch,City Cafe,2026-01-05", // different category
        "Food,450.00,Team lunch,Other Cafe,2026-01-05", // different merchant
      ].join("\n"),
    );

    expect(result.duplicateWarnings).toEqual([]);
    expect(inserted).toHaveLength(5);
  });

  it("scopes the already-filed lookup to the caller's own org and user", async () => {
    const { selectedWhere } = await importCsv(ROW);
    const bound = boundValues(selectedWhere);
    expect(bound).toContain("org-1");
    expect(bound).toContain("user-1");
  });
});
