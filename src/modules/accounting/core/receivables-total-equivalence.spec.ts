import { AccountingReceivablesService } from "./accounting-receivables.service";
import { decodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-1";

function makeRow(id: number, name: string, outstanding = "150.00") {
  return {
    clientId: id,
    clientName: name,
    state: "KA",
    gstin: null as string | null,
    invoiceCount: 2,
    outstanding,
  };
}

function buildService(rows: ReturnType<typeof makeRow>[]): AccountingReceivablesService {
  const chainMethods = [
    "from", "leftJoin", "innerJoin", "where", "having", "groupBy",
    "as", "$dynamic", "orderBy",
  ] as const;

  function makeListChain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of chainMethods) c[m] = jest.fn(self);
    c["limit"] = jest.fn(() => Promise.resolve(rows));
    return c;
  }

  function makeSubChain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of chainMethods) c[m] = jest.fn(self);
    c["limit"] = jest.fn(self);
    return c;
  }

  let call = 0;
  const selectMock = jest.fn(() => {
    call++;
    if (call === 1) return makeSubChain();
    return makeListChain();
  });

  return new AccountingReceivablesService({ select: selectMock } as unknown as Db, {} as never);
}

const baseQuery = { limit: 20, cursor: undefined as string | undefined, q: undefined as string | undefined, onlyOutstanding: false as boolean | undefined };

describe("listCustomers — keyset cursor pagination", () => {
  it("returns data with no nextCursor when fewer rows than limit", async () => {
    const svc = buildService([makeRow(1, "Alpha"), makeRow(2, "Beta")]);

    const result = await svc.listCustomers(ORG, { ...baseQuery, limit: 20 });

    expect(result.data).toHaveLength(2);
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.hasMore).toBe(false);
  });

  it("sets nextCursor when sentinel row present (rows > limit)", async () => {
    const limit = 3;
    const rows = [makeRow(1, "Alpha"), makeRow(2, "Beta"), makeRow(3, "Gamma"), makeRow(4, "Delta")];
    const svc = buildService(rows);

    const result = await svc.listCustomers(ORG, { ...baseQuery, limit });

    expect(result.data).toHaveLength(3);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).not.toBeNull();
  });

  it("tie-breaking: cursor encodes both name and id so same-name rows page correctly", async () => {
    const limit = 2;
    const rows = [
      makeRow(10, "Acme Corp"),
      makeRow(20, "Acme Corp"),
      makeRow(30, "Acme Corp"),
    ];
    const svc = buildService(rows);

    const result = await svc.listCustomers(ORG, { ...baseQuery, limit });

    expect(result.pagination.hasMore).toBe(true);
    const pos = decodeCursor(result.pagination.nextCursor ?? undefined);
    expect(pos).not.toBeNull();
    expect(pos?.sortValue).toBe("Acme Corp");
    expect(pos?.id).toBe("20");
  });

  it("returns empty data with no cursor on zero rows", async () => {
    const svc = buildService([]);

    const result = await svc.listCustomers(ORG, { ...baseQuery, limit: 20 });

    expect(result.data).toHaveLength(0);
    expect(result.pagination.nextCursor).toBeNull();
  });
});
