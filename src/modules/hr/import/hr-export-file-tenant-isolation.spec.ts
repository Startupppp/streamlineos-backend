jest.mock("../../../common/tenant", () => ({
  withTenant: (_db: unknown, _opts: unknown, fn: (tx: unknown) => unknown) => fn(_db),
  withPublicToken: jest.fn(),
  runInTenantTransaction: jest.fn(),
  runInNewTenantTransaction: jest.fn(),
}));

import type { Db } from "../../../db/drizzle.module";
import { HrExportFileService } from "./hr-export-file.service";

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
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  return { db, where, findMany };
}

describe("HrExportFileService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes employee export batch query to attacker org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const mockStorage = { uploadFileStream: jest.fn(), deleteFile: jest.fn() };
    const svc = new HrExportFileService(db, mockStorage as never);
    const input = {
      orgId: ATTACKER,
      actorUserId: "actor-1",
      scope: "all" as const,
      filters: {},
    };
    await (svc as Record<string, unknown>)["fetchBatch"](input, null);
    const allWhere = where.mock.calls.flatMap((call: unknown[]) => sqlValues(call[0]));
    expect(allWhere).toContain(ATTACKER);
  });

  it("scopes employee export batch query to owner org (control — same-tenant access works)", async () => {
    const { db, where } = makeDb([]);
    const mockStorage = { uploadFileStream: jest.fn(), deleteFile: jest.fn() };
    const svc = new HrExportFileService(db, mockStorage as never);
    const input = {
      orgId: OWNER,
      actorUserId: "actor-2",
      scope: "all" as const,
      filters: {},
    };
    await (svc as Record<string, unknown>)["fetchBatch"](input, null);
    const allWhere = where.mock.calls.flatMap((call: unknown[]) => sqlValues(call[0]));
    expect(allWhere).toContain(OWNER);
  });
});
