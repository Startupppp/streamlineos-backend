import type { Db } from "../../../db/drizzle.module";
import { HrImportService } from "./hr-import.service";
import { HrExportJobsService } from "./hr-export-jobs.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"]) ? sqlValues(r["queryChunks"], seen) : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

function makeDb(rows: unknown[]) {
  const where = jest.fn();
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const builder = {
    from: jest.fn(), where, orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.groupBy.mockReturnValue(builder);
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst }) });
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows), onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue(builder), query: queryProxy, insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }), execute: jest.fn().mockResolvedValue(rows) } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("HrImportService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: "job-1", orgId: OWNER, status: "PENDING" };

  it("scopes import job list to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const mockCommit = { commit: jest.fn() };
    const svc = new HrImportService(db, mockAudit as never, mockCommit as never);
    await svc.listJobs(ATTACKER, { page: 1, limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns import jobs for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const mockCommit = { commit: jest.fn() };
    const svc = new HrImportService(db, mockAudit as never, mockCommit as never);
    await svc.listJobs(OWNER, { page: 1, limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrExportJobsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: "job-1", orgId: OWNER, requesterUserId: "user-1", status: "COMPLETE" };

  it("throws when requester org does not own export job (cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const mockStorage = { getFileStream: jest.fn(), storeFile: jest.fn() };
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) };
    const svc = new HrExportJobsService(db, mockStorage as never, mockAccess as never);
    await expect(svc.getForRequester(ATTACKER, "user-1", "job-1")).rejects.toThrow();
  });

  it("returns export job for owning org requester (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockStorage = { getFileStream: jest.fn(), storeFile: jest.fn() };
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) };
    const svc = new HrExportJobsService(db, mockStorage as never, mockAccess as never);
    await svc.getForRequester(OWNER, "user-1", "job-1");
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});
