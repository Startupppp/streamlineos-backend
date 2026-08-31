import type { Db } from "../../../db/drizzle.module";
import { HrTemplateRenderService } from "./hr-template-render.service";

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
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  return { db, where, findMany };
}

describe("HrTemplateRenderService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes org lookup to attacker org in buildContext (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const mockEmployment = {
      getFacts: jest.fn().mockResolvedValue({ employeeNumber: null, designation: null, joiningDate: null, departmentId: null, managerUserId: null }),
      getSensitiveFacts: jest.fn().mockResolvedValue(null),
    };
    const svc = new HrTemplateRenderService(db, mockEmployment as never);
    await svc.buildContext(ATTACKER, "actor-1", undefined, undefined, false);
    const allWhere = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allWhere).toContain(ATTACKER);
  });

  it("scopes org lookup to owner org in buildContext (control — same-tenant access works)", async () => {
    const { db, where } = makeDb([{ name: "Test Corp", country: "IN" }]);
    const mockEmployment = {
      getFacts: jest.fn().mockResolvedValue({ employeeNumber: null, designation: null, joiningDate: null, departmentId: null, managerUserId: null }),
      getSensitiveFacts: jest.fn().mockResolvedValue(null),
    };
    const svc = new HrTemplateRenderService(db, mockEmployment as never);
    await svc.buildContext(OWNER, "actor-2", undefined, undefined, false);
    const allWhere = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allWhere).toContain(OWNER);
  });

  it("scopes employee lookup to org when employeeId provided (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const mockEmployment = {
      getFacts: jest.fn().mockResolvedValue({ employeeNumber: null, designation: null, joiningDate: null, departmentId: null, managerUserId: null }),
      getSensitiveFacts: jest.fn().mockResolvedValue(null),
    };
    const svc = new HrTemplateRenderService(db, mockEmployment as never);
    await svc.buildContext(ATTACKER, "actor-1", 42, undefined, false);
    const allWhere = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allWhere).toContain(ATTACKER);
  });
});
