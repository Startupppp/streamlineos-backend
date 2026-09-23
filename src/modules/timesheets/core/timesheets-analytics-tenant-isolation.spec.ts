import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ApprovalsBulkService } from "./approvals-bulk.service";
import { TimesheetAnalyticsService } from "./timesheet-analytics.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";
const ACTOR_ID = "user-actor";

function makeUser(orgId: string): CurrentUserContext {
  return { orgId, userId: ACTOR_ID, principal: { kind: "human-session", membershipId: 1 } } as unknown as CurrentUserContext;
}

type SelectChain = {
  then: (fn: (v: unknown[]) => unknown) => Promise<unknown>;
  catch: (fn: (e: unknown) => unknown) => Promise<unknown>;
  finally: (fn: () => void) => Promise<unknown[]>;
  limit: jest.Mock;
  groupBy: jest.Mock;
  orderBy: jest.Mock;
  leftJoin: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
};

function makeSelectChain(rows: unknown[] = []) {
  const where = jest.fn();
  const chain: SelectChain = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    limit: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    where,
  };
  chain.limit.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  where.mockReturnValue(chain);
  return { where, chain };
}

describe("ApprovalsBulkService — cross-tenant isolation", () => {
  it("rejectPeriod: throws NotFoundException for a period in a different org (deny)", async () => {
    const { where } = makeSelectChain([]);
    const from = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest.fn().mockReturnValue({ from }),
      transaction: jest.fn(),
    } as unknown as Db;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as never;
    const approvals = { assertCanActOnPeriod: jest.fn().mockResolvedValue(undefined) } as never;
    const rateResolver = { resolveMany: jest.fn().mockResolvedValue([]) } as never;
    const svc = new ApprovalsBulkService(db, audit, approvals, rateResolver);
    await expect(svc.rejectPeriod(makeUser(ATTACKER), 1, { reason: "bad" })).rejects.toThrow(NotFoundException);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("rejectPeriod: rejects a period for the owning org (control)", async () => {
    const OWNER_MEMBERSHIP = 10;
    const period = {
      id: 1,
      orgId: OWNER,
      status: "SUBMITTED",
      userMembershipId: OWNER_MEMBERSHIP,
      currentApproverMembershipId: null,
      periodStart: "2025-01-01",
      periodEnd: "2025-01-07",
    };
    const transition = {
      eventSeq: 3,
      userMembershipId: OWNER_MEMBERSHIP,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      status: "REJECTED",
      totalHours: "8.00",
      billableHours: "8.00",
      nonBillableHours: "0.00",
    };
    const returning = jest.fn().mockResolvedValue([transition]);
    const updateWhere = jest.fn().mockImplementation(() => Object.assign(Promise.resolve([]), { returning }));
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const tx = {
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    };
    const reads = [
      makeSelectChain([period]),
      makeSelectChain([{ id: OWNER_MEMBERSHIP, userId: ACTOR_ID }]),
      makeSelectChain([{ ...period, status: "REJECTED" }]),
    ];
    let callCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        const { chain } = reads[Math.min(callCount++, reads.length - 1)]!;
        return { from: jest.fn().mockReturnValue(chain) };
      }),
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    } as unknown as Db;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as never;
    const approvals = {
      assertCanActOnPeriod: jest.fn().mockResolvedValue(undefined),
      notifyPeriodRejected: jest.fn().mockResolvedValue(undefined),
    };
    const rateResolver = { resolveMany: jest.fn().mockResolvedValue([]) } as never;
    const svc = new ApprovalsBulkService(db, audit, approvals as never, rateResolver);
    const result = await svc.rejectPeriod(makeUser(OWNER), 1, { reason: "rejected" });
    expect(result).toBeDefined();
    const vals = sqlValues(reads[0]!.where.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
    const ownerLookup = sqlValues(reads[1]!.where.mock.calls[0]?.[0]);
    expect(ownerLookup).toContain(OWNER);
    expect(ownerLookup).not.toContain(ATTACKER);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: OWNER, eventType: "timesheets.period.rejected" }),
    );
    expect(approvals.notifyPeriodRejected).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER }),
      expect.objectContaining({ periodId: 1, ownerUserId: ACTOR_ID }),
    );
  });
});

describe("TimesheetAnalyticsService — cross-tenant isolation", () => {
  it("getCompliance: where clause carries attacker orgId — only attacker data queried (deny)", async () => {
    const { where, chain } = makeSelectChain([]);
    const from = jest.fn().mockReturnValue(chain);
    const db = {
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
    const access = { scopeFor: jest.fn().mockResolvedValue("all") } as unknown as AccessService;
    const svc = new TimesheetAnalyticsService(db, access);
    const result = await svc.getCompliance(makeUser(ATTACKER), { startDate: "2025-01-01", endDate: "2025-01-31" });
    expect(result.users).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const vals = where.mock.calls.flatMap(([arg]) => sqlValues(arg));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("getCompliance: returns data scoped to the owner org (control)", async () => {
    const { where, chain } = makeSelectChain([]);
    const from = jest.fn().mockReturnValue(chain);
    const db = {
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
    const access = { scopeFor: jest.fn().mockResolvedValue("all") } as unknown as AccessService;
    const svc = new TimesheetAnalyticsService(db, access);
    const result = await svc.getCompliance(makeUser(OWNER), { startDate: "2025-01-01", endDate: "2025-01-31" });
    expect(result.users).toHaveLength(0);
    const vals = where.mock.calls.flatMap(([arg]) => sqlValues(arg));
    expect(vals).toContain(OWNER);
    expect(vals).not.toContain(ATTACKER);
  });
});
