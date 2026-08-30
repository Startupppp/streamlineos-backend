import type { Db } from "../../db/drizzle.module";
import { PayrollCommandReceiptsService } from "./command-receipts.service";
import { IncentivesService } from "./hr-payroll/incentives.service";
import { EssSelfServiceService } from "./insights/ess-self-service.service";

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
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(rows),
        onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }),
      }),
    }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue(builder), query: queryProxy } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function allArgs(where: jest.Mock, findFirst: jest.Mock, findMany?: jest.Mock): unknown[] {
  const wh = where.mock.calls.flatMap((c) => sqlValues(c[0]));
  const ff = findFirst.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"]));
  const fm = findMany ? findMany.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"])) : [];
  return [...wh, ...ff, ...fm];
}

describe("PayrollCommandReceiptsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes receipt lookup to attacker org (cross-tenant isolation)", async () => {
    const { db, findFirst, where, findMany } = makeDb([]);
    const svc = new PayrollCommandReceiptsService(db);
    const result = await svc.begin({
      orgId: ATTACKER,
      command: "run.create",
      idempotencyKey: "key-1",
      actorId: "actor-1",
    });
    expect(result.kind).toBe("fresh");
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes receipt lookup to owner org (control — same-tenant receipt check)", async () => {
    const EXISTING = { id: 1, orgId: OWNER, command: "run.create", idempotencyKey: "key-2", status: "SUCCEEDED", response: { ok: true }, requestHash: null, startedAt: new Date() };
    const { db, findFirst, where, findMany } = makeDb([EXISTING]);
    const svc = new PayrollCommandReceiptsService(db);
    const result = await svc.begin({
      orgId: OWNER,
      command: "run.create",
      idempotencyKey: "key-2",
      actorId: "actor-2",
    });
    expect(result.kind).toBe("replay");
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });
});

describe("IncentivesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes incentive list to attacker org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) };
    const svc = new IncentivesService(db, mockAccess as never);
    await svc.getIncentives(ATTACKER, { page: 1, limit: 20 });
    const allWhere = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allWhere).toContain(ATTACKER);
  });

  it("scopes incentive list to owner org (control — same-tenant access works)", async () => {
    const { db, where } = makeDb([]);
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) };
    const svc = new IncentivesService(db, mockAccess as never);
    await svc.getIncentives(OWNER, { page: 1, limit: 20 });
    const allWhere = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allWhere).toContain(OWNER);
  });

  it("scopes incentive stats to org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([{ totalRevenue: "0", approvedCount: "0", pendingCount: "0", thisMonth: "0" }]);
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) };
    const svc = new IncentivesService(db, mockAccess as never);
    await svc.getIncentiveStats(ATTACKER);
    const allWhere = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allWhere).toContain(ATTACKER);
  });

  it("scopes incentive approval check to actor org (cross-tenant isolation)", async () => {
    const { db, findFirst, where, findMany } = makeDb([]);
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["hr:payroll:approve", "all"]])) };
    const svc = new IncentivesService(db, mockAccess as never);
    const actor = { orgId: ATTACKER, userId: "u1", isOrgOwner: false };
    const result = await svc.approveIncentive(actor as never, 999, { approvedAmount: "1000" });
    expect(result.ok).toBe(false);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("EssSelfServiceService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes payroll run check to org when updating bank details (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockEss = { getActiveToggles: jest.fn().mockResolvedValue({ essAllowBankUpdate: true, essAllowReimbursements: true, essAllowLoanRequests: true, essAllowTaxDeclarations: true }), getActiveWindow: jest.fn().mockResolvedValue(null) };
    const mockLoans = { listLoans: jest.fn().mockResolvedValue([]), createLoan: jest.fn().mockResolvedValue({}) };
    const mockReimbursements = { createReimbursement: jest.fn().mockResolvedValue({}), listReimbursements: jest.fn().mockResolvedValue([]) };
    const mockTax = { listMine: jest.fn().mockResolvedValue([]), listProofs: jest.fn().mockResolvedValue([]), createOrUpdate: jest.fn().mockResolvedValue({}) };
    const mockEmploymentFacts = { getSensitiveFacts: jest.fn().mockResolvedValue({ bankDetails: null }) };
    const svc = new EssSelfServiceService(db, mockEss as never, mockLoans as never, mockReimbursements as never, mockTax as never, mockEmploymentFacts as never);

    const body = { accountNumber: "12345678", bankName: "State Bank", branch: "Main", ifsc: "SBIN0001234", accountHolder: "John" };
    await expect(
      svc.updateBankDetails(ATTACKER, "user-1", body as never)
    ).resolves.toBeDefined();
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes payroll run check to owner org (control — same-tenant access works)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockEss = { getActiveToggles: jest.fn().mockResolvedValue({ essAllowBankUpdate: true, essAllowReimbursements: true, essAllowLoanRequests: true, essAllowTaxDeclarations: true }), getActiveWindow: jest.fn().mockResolvedValue(null) };
    const mockLoans = { listLoans: jest.fn().mockResolvedValue([]), createLoan: jest.fn().mockResolvedValue({}) };
    const mockReimbursements = { createReimbursement: jest.fn().mockResolvedValue({}), listReimbursements: jest.fn().mockResolvedValue([]) };
    const mockTax = { listMine: jest.fn().mockResolvedValue([]), listProofs: jest.fn().mockResolvedValue([]), createOrUpdate: jest.fn().mockResolvedValue({}) };
    const mockEmploymentFacts = { getSensitiveFacts: jest.fn().mockResolvedValue({ bankDetails: null }) };
    const svc = new EssSelfServiceService(db, mockEss as never, mockLoans as never, mockReimbursements as never, mockTax as never, mockEmploymentFacts as never);

    const body = { accountNumber: "87654321", bankName: "HDFC", branch: "City", ifsc: "HDFC0001234", accountHolder: "Jane" };
    await expect(
      svc.updateBankDetails(OWNER, "user-2", body as never)
    ).resolves.toBeDefined();
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes tax declaration lookup to org (cross-tenant isolation)", async () => {
    const { db, findFirst, where, findMany } = makeDb([]);
    const mockEss = { getActiveToggles: jest.fn().mockResolvedValue({ essAllowTaxDeclarations: true }), getActiveWindow: jest.fn().mockResolvedValue({ financialYear: "2024-25", closesAt: new Date() }) };
    const mockLoans = { listLoans: jest.fn().mockResolvedValue([]) };
    const mockReimbursements = { listReimbursements: jest.fn().mockResolvedValue([]) };
    const mockTax = { listMine: jest.fn().mockResolvedValue([]), listProofs: jest.fn().mockResolvedValue([]) };
    const mockEmploymentFacts = { getSensitiveFacts: jest.fn().mockResolvedValue(null) };
    const svc = new EssSelfServiceService(db, mockEss as never, mockLoans as never, mockReimbursements as never, mockTax as never, mockEmploymentFacts as never);
    await svc.getTaxDeclaration(ATTACKER, "user-1");
    const taxListArgs = (mockTax.listMine as jest.Mock).mock.calls;
    expect(taxListArgs.length).toBeGreaterThan(0);
    expect(taxListArgs[0]).toContain(ATTACKER);
  });
});
