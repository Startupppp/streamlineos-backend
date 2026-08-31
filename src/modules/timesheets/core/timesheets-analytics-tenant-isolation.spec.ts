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
  return { orgId, userId: ACTOR_ID } as CurrentUserContext;
}

function makeSelectChain(rows: unknown[] = []) {
  const where = jest.fn();
  const chain = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    limit: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    leftJoin: jest.fn(),
  };
  chain.limit.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
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
    const svc = new ApprovalsBulkService(db, audit, approvals);
    await expect(svc.rejectPeriod(makeUser(ATTACKER), 1, { reason: "bad" })).rejects.toThrow(NotFoundException);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("rejectPeriod: rejects a period for the owning org (control)", async () => {
    const period = { id: 1, orgId: OWNER, status: "SUBMITTED", userId: ACTOR_ID, currentApproverId: null };
    const { where } = makeSelectChain([period]);
    const updateWhere = jest.fn().mockResolvedValue([]);
    const tx = {
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    };
    const from = jest.fn().mockReturnValue({ where });
    const updatedPeriod = { ...period, status: "REJECTED" };
    const { where: where2 } = makeSelectChain([updatedPeriod]);
    const from2 = jest.fn().mockReturnValue({ where: where2 });
    let callCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => ({ from: callCount++ === 0 ? from : from2 })),
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    } as unknown as Db;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as never;
    const approvals = { assertCanActOnPeriod: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new ApprovalsBulkService(db, audit, approvals);
    const result = await svc.rejectPeriod(makeUser(OWNER), 1, { reason: "rejected" });
    expect(result).toBeDefined();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
  });
});

describe("TimesheetAnalyticsService — cross-tenant isolation", () => {
  it("getCompliance: where clause carries attacker orgId — only attacker data queried (deny)", async () => {
    const { where } = makeSelectChain([]);
    const from = jest.fn().mockReturnValue({ where });
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
    const { where } = makeSelectChain([]);
    const from = jest.fn().mockReturnValue({ where });
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
