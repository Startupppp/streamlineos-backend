import type { Db } from "../../db/drizzle.module";
import { WorkerEngagementsService } from "./worker-engagements.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }) });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const select = jest.fn().mockReturnValue({ from });
  const db = {
    select,
    query: {
      workers: { findFirst: jest.fn().mockResolvedValue(null) },
      workerEngagements: { findMany: jest.fn().mockResolvedValue([]) },
      organizationPeople: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  } as unknown as Db;
  return { db, where };
}

describe("WorkerEngagementsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("returns empty data for a different org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const mockAudit = { log: jest.fn() } as any;
    const mockIdentities = {} as any;
    const svc = new WorkerEngagementsService(db, mockAudit, mockIdentities);
    const result = await svc.listWorkers(ATTACKER, { limit: 20 });
    expect(result.data).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("returns workers for the owning org (control — same-tenant)", async () => {
    const workerRow = { workerId: "w-1", organizationId: OWNER, displayName: "Bob" };
    const { db } = makeDb([workerRow]);
    const mockAudit = { log: jest.fn() } as any;
    const mockIdentities = {} as any;
    const svc = new WorkerEngagementsService(db, mockAudit, mockIdentities);
    const result = await svc.listWorkers(OWNER, { limit: 20 });
    expect(result.data).toHaveLength(1);
  });
});
