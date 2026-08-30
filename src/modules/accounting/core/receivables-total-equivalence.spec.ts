import { AccountingReceivablesService } from "./accounting-receivables.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-1";

function makeRow(id: number) {
  return {
    clientId: id,
    clientName: `Client ${id}`,
    state: "KA",
    gstin: null as string | null,
    invoiceCount: 2,
    outstanding: "150.00",
  };
}

function buildService(rows: ReturnType<typeof makeRow>[]): AccountingReceivablesService {
  const orderBy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) });
  const where = jest.fn().mockReturnValue({ orderBy });
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ where }) }),
    }),
  } as unknown as Db;
  return new AccountingReceivablesService(db);
}

const baseQuery = { cursor: undefined as number | undefined, limit: 20, q: undefined as string | undefined, onlyOutstanding: false };

describe("listCustomers — cursor pagination", () => {
  for (const onlyOutstanding of [false, true]) {
    const view = onlyOutstanding ? "filtered to outstanding" : "unfiltered";

    describe(view, () => {
      it("returns data array when fewer rows than limit", async () => {
        const svc = buildService([makeRow(1), makeRow(2)]);

        const result = await svc.listCustomers(ORG, { ...baseQuery, onlyOutstanding });

        expect(result.data).toHaveLength(2);
        expect(result.hasMore).toBe(false);
        expect(result.nextCursor).toBeNull();
      });

      it("sets hasMore and nextCursor when a sentinel row is returned", async () => {
        const rows = Array.from({ length: 21 }, (_, i) => makeRow(i + 1));
        const svc = buildService(rows);

        const result = await svc.listCustomers(ORG, { ...baseQuery, onlyOutstanding });

        expect(result.data).toHaveLength(20);
        expect(result.hasMore).toBe(true);
        expect(result.nextCursor).toBe(20);
      });

      it("returns empty data on no rows", async () => {
        const svc = buildService([]);

        const result = await svc.listCustomers(ORG, { ...baseQuery, onlyOutstanding });

        expect(result.data).toHaveLength(0);
        expect(result.hasMore).toBe(false);
      });
    });
  }
});
