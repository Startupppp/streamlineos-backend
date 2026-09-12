import type { Db } from "../../../db/drizzle.module";
import { PayrollExportsReadService } from "./payroll-exports-read.service";
import { ScopedRead } from "../../access/scoped-read";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

describe("PayrollExportsReadService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeSelectChain(rows: unknown[]) {
    let capturedWhere: unknown;
    const limit = jest.fn().mockResolvedValue(rows);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockImplementation((pred: unknown) => {
      capturedWhere = pred;
      return { orderBy, limit };
    });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    const db = {
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
    return { db, getWhere: () => capturedWhere };
  }

  function makeSvc(db: Db) {
    const cache = {
      cachedVersioned: jest.fn().mockImplementation((_ns: string, _key: string, fn: () => unknown) => fn()),
    };
    return new PayrollExportsReadService(db, cache as never, {} as never);
  }

  it("DENY: listExports queries only the requesting org's exports (cross-tenant isolation)", async () => {
    const { db, getWhere } = makeSelectChain([]);
    const svc = makeSvc(db);

    const result = await svc.listExports(ScopedRead.of(ATTACKER_ORG, "attacker", "all"), { limit: 20 });

    expect(result.data).toHaveLength(0);
    const vals = sqlValues(getWhere());
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });

  it("CONTROL: listExports scopes to the owner org", async () => {
    const { db, getWhere } = makeSelectChain([]);
    const svc = makeSvc(db);

    await svc.listExports(ScopedRead.of(OWNER_ORG, "owner", "all"), { limit: 20 });

    expect(sqlValues(getWhere())).toContain(OWNER_ORG);
  });

  it("DENY: getExportRows scopes the read to the requesting org (cross-tenant isolation)", async () => {
    const { db, getWhere } = makeSelectChain([]);
    const svc = makeSvc(db);

    await expect(svc.getExportRows(ScopedRead.of(ATTACKER_ORG, "attacker", "all"), 1)).rejects.toThrow("Export not found");
    const vals = sqlValues(getWhere());
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });
});
