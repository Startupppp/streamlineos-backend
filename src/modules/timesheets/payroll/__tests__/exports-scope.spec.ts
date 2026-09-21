import { PgDialect } from "drizzle-orm/pg-core";
import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { ScopedRead } from "../../../access/scoped-read";
import { PayrollExportsReadService } from "../payroll-exports-read.service";

const ORG = "org-scope";
const dialect = new PgDialect();

function harness(rows: unknown[]) {
  let where: unknown;
  const chain: Record<string, unknown> = {};
  for (const step of ["from", "leftJoin", "orderBy"]) chain[step] = () => chain;
  chain["where"] = (predicate: unknown) => {
    where = predicate;
    return chain;
  };
  chain["limit"] = () => Promise.resolve(rows);
  const db = { select: () => chain } as unknown as Db;
  const cache = {
    cachedVersioned: jest.fn((_ns: string, _key: string, fn: () => Promise<unknown>) => fn()),
  };
  const service = new PayrollExportsReadService(db, cache as never, {} as never);
  return { service, cache, renderedWhere: () => dialect.sqlToQuery(where as never).sql, sawWhere: () => where !== undefined };
}

const exportRow = {
  id: 9,
  orgId: ORG,
  exportType: "PAYROLL",
  status: "COMPLETED",
  dateRangeStart: "2026-06-01",
  dateRangeEnd: "2026-06-07",
  format: "CSV",
  entryCount: 2,
  totalHours: "16.00",
  note: null,
  ackStatus: null,
  ackAt: null,
  snapshot: [],
  filters: {},
  createdByMembershipId: 1,
  eventSeq: 1,
  createdAt: new Date("2026-06-08T00:00:00Z"),
};

describe("payroll export reads apply the caller's DataScope", () => {
  it("an unrestricted reader lists the organisation's exports", async () => {
    const { service, renderedWhere } = harness([{ export: exportRow, creatorName: "Priya" }]);

    const page = await service.listExports(ScopedRead.of(ORG, "owner", "all"), { limit: 20 });

    expect(page.data).toHaveLength(1);
    expect(renderedWhere()).toContain("true");
  });

  it("an own-scoped reader is shown no export, because no export is theirs", async () => {
    const { service, renderedWhere } = harness([{ export: exportRow, creatorName: "Priya" }]);

    await service.listExports(ScopedRead.of(ORG, "member", "own"), { limit: 20 });

    expect(renderedWhere()).toContain("false");
  });

  it("a team-scoped reader is shown no export either", async () => {
    const { service, renderedWhere } = harness([]);

    await service.listExports(ScopedRead.of(ORG, "lead", "team"), { limit: 20 });

    expect(renderedWhere()).toContain("false");
  });

  it("a denied reader gets an empty page without a query", async () => {
    const { service, sawWhere } = harness([]);

    const page = await service.listExports(ScopedRead.of(ORG, "nobody", "none"), { limit: 20 });

    expect(page.data).toEqual([]);
    expect(sawWhere()).toBe(false);
  });

  it("keys the cache by scope, so an owner's page is never served to a member", async () => {
    const { service, cache } = harness([]);

    await service.listExports(ScopedRead.of(ORG, "owner", "all"), { limit: 20 });
    await service.listExports(ScopedRead.of(ORG, "member", "own"), { limit: 20 });

    const keys = cache.cachedVersioned.mock.calls.map((call) => call[1]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("the rows behind an export are 404 below `all`, confirming nothing", async () => {
    const { service, renderedWhere } = harness([]);

    await expect(service.getExportRows(ScopedRead.of(ORG, "member", "own"), 9)).rejects.toBeInstanceOf(NotFoundException);
    expect(renderedWhere()).toContain("false");
  });

  it("a denied reader gets the same 404 without a query", async () => {
    const { service, sawWhere } = harness([]);

    await expect(service.getExportRows(ScopedRead.of(ORG, "nobody", "none"), 9)).rejects.toBeInstanceOf(NotFoundException);
    expect(sawWhere()).toBe(false);
  });
});
