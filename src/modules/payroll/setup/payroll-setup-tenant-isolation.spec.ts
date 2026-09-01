import type { Db } from "../../../db/drizzle.module";
import { PolicyMutationService } from "./policy-mutation.service";
import { PolicyQueryService } from "./policy-query.service";
import { PayslipTemplatesService } from "../payout/payslip-templates.service";
import { PayrollComponentsService } from "./components.service";
import { PayrollTemplatesService } from "./templates.service";

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
  const txDb = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows), onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }),
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  const db = {
    ...txDb,
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn(txDb)),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function allArgs(where: jest.Mock, findFirst: jest.Mock, findMany?: jest.Mock): unknown[] {
  const wh = where.mock.calls.flatMap((c) => sqlValues(c[0]));
  const ff = findFirst.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"]));
  const fm = findMany ? findMany.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"])) : [];
  return [...wh, ...ff, ...fm];
}

describe("PolicyMutationService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes policy creation check to actor org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockTemplates = { getById: jest.fn().mockResolvedValue(null) };
    const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = new PolicyMutationService(db, mockTemplates as never, mockAudit as never);
    const actor = { orgId: ATTACKER, userId: "u1", isOrgOwner: false };
    await svc.create(actor as never, { name: "Test Policy" } as never);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes policy creation check to owner org (control — same-tenant creates policy)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockTemplates = { getById: jest.fn().mockResolvedValue(null) };
    const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = new PolicyMutationService(db, mockTemplates as never, mockAudit as never);
    const actor = { orgId: OWNER, userId: "u2", isOrgOwner: true };
    await svc.create(actor as never, { name: "Owner Policy" } as never);
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes policy update to actor org (cross-tenant isolation — update checks orgId)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockTemplates = { getById: jest.fn().mockResolvedValue(null) };
    const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = new PolicyMutationService(db, mockTemplates as never, mockAudit as never);
    const actor = { orgId: ATTACKER, userId: "u1", isOrgOwner: false };
    await expect(svc.update(actor as never, 999, { name: "hacked" } as never)).rejects.toThrow();
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("PolicyQueryService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes getCurrent to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockTemplates = { getById: jest.fn().mockResolvedValue(null), list: jest.fn().mockResolvedValue([]) };
    const svc = new PolicyQueryService(db, mockTemplates as never);
    await svc.getCurrent(ATTACKER);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes getCurrent to owner org (control — same-tenant returns policy)", async () => {
    const { db, where, findFirst, findMany } = makeDb([{ id: 1, orgId: OWNER, name: "Policy A", activeVersionId: null }]);
    const mockTemplates = { getById: jest.fn().mockResolvedValue(null), list: jest.fn().mockResolvedValue([]) };
    const svc = new PolicyQueryService(db, mockTemplates as never);
    await svc.getCurrent(OWNER);
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes listVersions to attacker org (cross-tenant isolation — version lookup checks orgId)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockTemplates = { getById: jest.fn().mockResolvedValue(null), list: jest.fn().mockResolvedValue([]) };
    const svc = new PolicyQueryService(db, mockTemplates as never);
    await expect(svc.listVersions(ATTACKER, 999)).rejects.toThrow();
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("PayslipTemplatesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes template list to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayslipTemplatesService(db);
    await svc.list(ATTACKER);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes template list to owner org (control — same-tenant returns templates)", async () => {
    const { db, where, findFirst, findMany } = makeDb([{ id: 1, orgId: OWNER, name: "Default", isDefault: true }]);
    const svc = new PayslipTemplatesService(db);
    const result = await svc.list(OWNER);
    expect(result).toBeDefined();
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes template update to org (cross-tenant isolation — update checks orgId + templateId)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayslipTemplatesService(db);
    await expect(svc.update(ATTACKER, 999, { name: "hacked" } as never)).rejects.toThrow();
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes template delete to org (cross-tenant isolation — delete checks orgId + templateId)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayslipTemplatesService(db);
    await expect(svc.delete(ATTACKER, 999)).rejects.toThrow();
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("PayrollComponentsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes component list to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollComponentsService(db);
    await svc.list(ATTACKER, { limit: 20 });
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes component list to owner org (control — same-tenant returns items)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollComponentsService(db);
    await svc.list(OWNER, { limit: 20 });
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes component update to actor org (cross-tenant isolation — update asserts orgId)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollComponentsService(db);
    const actor = { orgId: ATTACKER, userId: "u1", isOrgOwner: false };
    await expect(svc.update(actor as never, 999, { name: "hacked" } as never)).rejects.toThrow();
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("PayrollTemplatesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes template list to show only org + system templates (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollTemplatesService(db);
    await svc.list(ATTACKER, { limit: 20 });
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes template list to owner org (control — same-tenant access works)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollTemplatesService(db);
    await svc.list(OWNER, { limit: 20 });
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes getById to org (cross-tenant isolation — getById uses orgId in predicate)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollTemplatesService(db);
    await expect(svc.getById(ATTACKER, 999)).rejects.toThrow();
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes duplicate to org (cross-tenant isolation — duplicate checks orgId)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollTemplatesService(db);
    await expect(svc.duplicate(ATTACKER, 999, { name: "copy" } as never)).rejects.toThrow();
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});
