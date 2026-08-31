import { AccountingReceivablesService } from "./accounting-receivables.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-1";

function makeRow(id: number, total: number) {
  return {
    clientId: id,
    clientName: `Client ${id}`,
    state: "KA",
    gstin: null as string | null,
    invoiceCount: 2,
    outstanding: "150.00",
    total: String(total),
  };
}

function buildService(rows: ReturnType<typeof makeRow>[]): AccountingReceivablesService {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of ["from", "leftJoin", "innerJoin", "where", "having", "groupBy", "as", "$dynamic", "orderBy", "offset"])
    (chain as Record<string, jest.Mock>)[method] = jest.fn(self);
  (chain as Record<string, jest.Mock>)["limit"] = jest.fn().mockResolvedValue(rows);
  const db = { select: jest.fn(() => chain) } as unknown as Db;
  return new AccountingReceivablesService(db);
}

const baseQuery = { page: 1, pageSize: 20, q: undefined as string | undefined, onlyOutstanding: false };

describe("listCustomers — offset pagination", () => {
  for (const onlyOutstanding of [false, true]) {
    const view = onlyOutstanding ? "filtered to outstanding" : "unfiltered";

    describe(view, () => {
      it("returns items array when fewer rows than page size", async () => {
        const svc = buildService([makeRow(1, 2), makeRow(2, 2)]);

        const result = await svc.listCustomers(ORG, { ...baseQuery, onlyOutstanding });

        expect(result.items).toHaveLength(2);
        expect(result.total).toBe(2);
        expect(result.totalPages).toBe(1);
      });

      it("reports total count from the windowed column when rows reach the page size", async () => {
        const rows = Array.from({ length: 20 }, (_, i) => makeRow(i + 1, 21));
        const svc = buildService(rows);

        const result = await svc.listCustomers(ORG, { ...baseQuery, onlyOutstanding });

        expect(result.items).toHaveLength(20);
        expect(result.total).toBe(21);
        expect(result.totalPages).toBe(2);
      });

      it("returns empty items on no rows", async () => {
        const svc = buildService([]);

        const result = await svc.listCustomers(ORG, { ...baseQuery, onlyOutstanding });

        expect(result.items).toHaveLength(0);
        expect(result.total).toBe(0);
      });
    });
  }
});
