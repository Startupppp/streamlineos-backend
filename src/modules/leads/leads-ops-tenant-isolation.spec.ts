import type { Db } from "../../db/drizzle.module";
import { LeadsOpsService } from "./leads-ops.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("LeadsOpsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(batchRow: unknown) {
    const findFirst = jest.fn().mockResolvedValue(batchRow);
    const db = {
      query: {
        leadImportBatches: { findFirst },
        users: { findFirst: jest.fn().mockResolvedValue(null) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    const audit = { log: jest.fn() };
    const dispatch = { emit: jest.fn() };
    const access = { getMembersWithPermission: jest.fn().mockResolvedValue([]) };
    const svc = new LeadsOpsService(db, audit as never, dispatch as never, access as never);
    return { svc, findFirst };
  }

  it("returns undefined for a different org's batch (cross-tenant isolation)", async () => {
    const { svc, findFirst } = makeService(undefined);
    const result = await svc.getImportBatch(ATTACKER, 42);
    expect(result).toBeUndefined();
    const call = findFirst.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns the batch for the owning org (control)", async () => {
    const { svc, findFirst } = makeService({ id: 42, orgId: OWNER });
    const result = await svc.getImportBatch(OWNER, 42);
    expect(result).toBeDefined();
    const call = findFirst.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(OWNER);
  });
});
