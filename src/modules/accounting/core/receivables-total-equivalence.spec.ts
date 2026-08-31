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

function buildService(
  rows: ReturnType<typeof makeRow>[],
  total: number,
  onlyOutstanding: boolean,
): AccountingReceivablesService {
  const chainMethods = [
    "from", "leftJoin", "innerJoin", "where", "having", "groupBy",
    "as", "$dynamic", "orderBy", "offset",
  ] as const;

  function makeSubChain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of chainMethods) c[m] = jest.fn(self);
    c["limit"] = jest.fn(self);
    return c;
  }

  function makeListChain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of chainMethods) c[m] = jest.fn(self);
    c["limit"] = jest.fn(() => Promise.resolve(rows));
    return c;
  }

  const countResolved = Promise.resolve([{ c: total }]);
  function makeCountChain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of ["from", "leftJoin", "where", "having", "groupBy", "as"]) c[m] = jest.fn(self);
    c["limit"] = jest.fn(self);
    c["then"] = (
      resolve: (v: Array<{ c: number }>) => unknown,
      reject?: (e: unknown) => unknown,
    ) => countResolved.then(resolve, reject);
    return c;
  }

  let call = 0;
  const selectMock = jest.fn(() => {
    call++;
    if (call === 1) return makeSubChain();
    if (call === 2) return makeListChain();
    if (onlyOutstanding && call === 3) return makeCountChain();
    if (onlyOutstanding && call === 4) return makeSubChain();
    return makeCountChain();
  });

  return new AccountingReceivablesService({ select: selectMock } as unknown as Db);
}

const baseQuery = { page: 1, pageSize: 20, q: undefined as string | undefined, onlyOutstanding: false };

describe("listCustomers — offset pagination with separate count query", () => {
  for (const onlyOutstanding of [false, true]) {
    const view = onlyOutstanding ? "filtered to outstanding" : "unfiltered";

    describe(view, () => {
      it("returns items array when fewer rows than page size", async () => {
        const svc = buildService([makeRow(1, 2), makeRow(2, 2)], 2, onlyOutstanding);

        const result = await svc.listCustomers(ORG, { ...baseQuery, onlyOutstanding });

        expect(result.items).toHaveLength(2);
        expect(result.total).toBe(2);
        expect(result.totalPages).toBe(1);
      });

      it("reports total count from the separate count query when rows reach the page size", async () => {
        const rows = Array.from({ length: 20 }, (_, i) => makeRow(i + 1, 21));
        const svc = buildService(rows, 21, onlyOutstanding);

        const result = await svc.listCustomers(ORG, { ...baseQuery, onlyOutstanding });

        expect(result.items).toHaveLength(20);
        expect(result.total).toBe(21);
        expect(result.totalPages).toBe(2);
      });

      it("returns empty items on no rows", async () => {
        const svc = buildService([], 0, onlyOutstanding);

        const result = await svc.listCustomers(ORG, { ...baseQuery, onlyOutstanding });

        expect(result.items).toHaveLength(0);
        expect(result.total).toBe(0);
      });
    });
  }
});
