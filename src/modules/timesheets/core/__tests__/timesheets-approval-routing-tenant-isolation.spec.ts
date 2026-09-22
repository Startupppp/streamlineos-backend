import type { Db } from "../../../../db/drizzle.module";
import type { TenantTx } from "../../../../db/drizzle.types";
import { TimesheetApprovalRoutingService } from "../approval-routing.service";
import { TimesheetApprovalEscalationSweepService } from "../approval-escalation-sweep.service";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeBuilder(rows: unknown[]) {
  const where = jest.fn();
  const limit = jest.fn();
  const orderBy = jest.fn();
  const leftJoin = jest.fn();
  const innerJoin = jest.fn();
  const forFn = jest.fn();

  const builder: Record<string, unknown> & { then: unknown; catch: unknown; finally: unknown } = {
    from: jest.fn(),
    where,
    limit,
    orderBy,
    leftJoin,
    innerJoin,
    for: forFn,
    then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  where.mockReturnValue(builder);
  limit.mockReturnValue(builder);
  orderBy.mockReturnValue(builder);
  leftJoin.mockReturnValue(builder);
  innerJoin.mockReturnValue(builder);
  forFn.mockReturnValue(builder);

  return { builder, where };
}

function makeDb(rows: unknown[] = []) {
  const { builder, where } = makeBuilder(rows);
  const db = {
    select: jest.fn().mockReturnValue(builder),
  } as unknown as Db;
  return { db, where };
}

function makeTx(rows: unknown[] = []) {
  const { builder, where } = makeBuilder(rows);
  const tx = {
    select: jest.fn().mockReturnValue(builder),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as TenantTx;
  return { tx, where };
}

describe("TimesheetApprovalRoutingService — cross-tenant isolation", () => {
  function makeService(db: Db) {
    const approvals = {
      resolve: jest.fn().mockResolvedValue({ kind: "unowned", explanation: "no chain" }),
    };
    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue({ get: jest.fn().mockReturnValue("all") }),
    };
    const employment = {
      getFacts: jest.fn().mockResolvedValue({ designation: null }),
    };
    const reportingLines = {
      checkManager: jest.fn().mockResolvedValue({ ok: true }),
    };
    return new TimesheetApprovalRoutingService(
      db,
      access as never,
      approvals as never,
      employment as never,
      reportingLines as never,
    );
  }

  it("dominantProjectManager: WHERE contains attacker orgId when attacker resolves a project (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = makeService(db);
    await svc.resolve({
      orgId: ATTACKER_ORG,
      subjectUserId: "user-attacker",
      entries: [{ projectId: 42 }],
      settings: { approvalMode: "MANAGER", approverSource: "REPORTING_MANAGER" },
    });
    const allVals = where.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("dominantProjectManager: WHERE contains owner orgId when owner resolves a project (control — same-tenant)", async () => {
    const { db, where } = makeDb([]);
    const svc = makeService(db);
    await svc.resolve({
      orgId: OWNER_ORG,
      subjectUserId: "user-owner",
      entries: [{ projectId: 7 }],
      settings: { approvalMode: "MANAGER", approverSource: "REPORTING_MANAGER" },
    });
    const allVals = where.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0]));
    expect(allVals).toContain(OWNER_ORG);
  });

  it("does not query the database when entries have no projectId (no cross-org exposure via null project)", async () => {
    const { db, where } = makeDb([]);
    const svc = makeService(db);
    await svc.resolve({
      orgId: ATTACKER_ORG,
      subjectUserId: "user-attacker",
      entries: [{ projectId: null }],
      settings: { approvalMode: "MANAGER", approverSource: "REPORTING_MANAGER" },
    });
    expect(where).not.toHaveBeenCalled();
  });
});

describe("TimesheetApprovalEscalationSweepService — cross-tenant isolation", () => {
  function makeService(db: Db) {
    const routing = {
      resolve: jest.fn().mockResolvedValue({ kind: "unowned", explanation: "no chain" }),
    };
    const audit = {
      record: jest.fn().mockResolvedValue(undefined),
      log: jest.fn().mockResolvedValue(undefined),
    };
    const notifications = {
      emit: jest.fn().mockResolvedValue(undefined),
    };
    return new TimesheetApprovalEscalationSweepService(
      db,
      routing as never,
      audit as never,
      notifications as never,
    );
  }

  it("escalateOrg: timesheetSettings WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { tx, where } = makeTx([]);
    const { db } = makeDb([]);
    const svc = makeService(db);
    await svc.escalateOrg(tx, ATTACKER_ORG, new Date("2026-09-22T00:00:00Z"));
    const allVals = where.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("escalateOrg: returns zero-outcome for attacker org with no settings (deny — isolation via org filter)", async () => {
    const { tx } = makeTx([]);
    const { db } = makeDb([]);
    const svc = makeService(db);
    const result = await svc.escalateOrg(tx, ATTACKER_ORG, new Date("2026-09-22T00:00:00Z"));
    expect(result.periodsOverdue).toBe(0);
    expect(result.periodsEscalated).toBe(0);
  });

  it("escalateOrg: timesheetSettings WHERE contains owner orgId (control — same-tenant)", async () => {
    const { tx, where } = makeTx([]);
    const { db } = makeDb([]);
    const svc = makeService(db);
    await svc.escalateOrg(tx, OWNER_ORG, new Date("2026-09-22T00:00:00Z"));
    const allVals = where.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0]));
    expect(allVals).toContain(OWNER_ORG);
  });

  it("escalateOrg: completes without error for own org (control — same-tenant)", async () => {
    const { tx } = makeTx([]);
    const { db } = makeDb([]);
    const svc = makeService(db);
    await expect(
      svc.escalateOrg(tx, OWNER_ORG, new Date("2026-09-22T00:00:00Z")),
    ).resolves.toBeDefined();
  });
});
