import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { ExpensesImportService } from "./expenses-import.service";
import { EXPENSE_IMPORT_FIELDS } from "./expenses-import-contract";

type InsertedRow = Record<string, unknown>;

async function importCsv(header: string, body: string) {
  const inserted: InsertedRow[] = [];
  // `useValue` is untyped, so the capture needs no cast to `Db`.
  const db = {
    // no expense is already on file in these cases; the duplicate pass reads nothing.
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({
      values: (rows: InsertedRow[]) => {
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
    content: `${header}\n${body}`,
  });
  return { result, inserted };
}

describe("expense import — one header normalizer, one field list (V-071)", () => {
  it("resolves Payment Method, payment_method and paymentMethod to one field", async () => {
    const spellings = ["Payment Method", "payment_method", "paymentMethod", "payment-method"];
    for (const spelling of spellings) {
      const { inserted } = await importCsv(`category,amount,${spelling}`, "Travel,10,UPI");
      expect({ spelling, paymentMethod: inserted[0]?.paymentMethod }).toEqual({
        spelling,
        paymentMethod: "UPI",
      });
    }
  });

  it("the exported template field list equals the keys the validator accepts", async () => {
    // A file whose headers ARE the exported template's columns, carrying the exported
    // samples, must import with every one of those values landing on the row. If a field
    // is dropped from the contract or renamed only on one side, a sample stops arriving.
    const header = EXPENSE_IMPORT_FIELDS.map((f) => f.key).join(",");
    const body = EXPENSE_IMPORT_FIELDS.map((f) => f.sample).join(",");
    const { inserted, result } = await importCsv(header, body);

    expect(result.skipped).toBe(0);
    expect(inserted).toHaveLength(1);
    for (const field of EXPENSE_IMPORT_FIELDS) {
      const landed = inserted[0]?.[field.key];
      // `amount` is stored as a decimal string at the column's own scale, so it is the
      // same money rather than the same characters.
      const same = field.key === "amount" ? Number(landed) === Number(field.sample) : landed === field.sample;
      expect({ key: field.key, landed, same }).toEqual({ key: field.key, landed, same: true });
    }
  });

  it("every required field is one the parser refuses a row without", async () => {
    const required = EXPENSE_IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(["amount"]);
    const { result } = await importCsv("category,amount", "Travel,");
    expect(result.skipped).toBe(1);
  });
});
