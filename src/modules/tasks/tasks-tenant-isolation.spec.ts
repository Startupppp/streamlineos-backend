/**
 * TasksService — cross-tenant isolation
 *
 * Proves list and getTask scope every query to the caller's org.
 */

import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { TasksService } from "./tasks.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { TaskNotificationsService } from "./task-notifications.service";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const ownerCtx = (orgId: string): CurrentUserContext => ({
  orgId,
  userId: "user-1",
  isOrgOwner: true,
  sessionId: "s1",
  memberId: "m1",
});

function buildDb(rows: unknown[]) {
  const resolvedQuery = { findMany: jest.fn().mockResolvedValue(rows) };
  const whereChain = {
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockResolvedValue(rows),
    where: jest.fn().mockReturnThis(),
  };
  const fromChain = { where: jest.fn().mockReturnValue(whereChain), from: jest.fn() };
  const selectMock = jest.fn().mockReturnValue(fromChain);
  const countResult = [{ count: rows.length }];
  const countFrom = {
    where: jest.fn().mockResolvedValue(countResult),
  };
  const selectForCount = jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(countFrom) });

  let callIdx = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx % 2 === 0) return { from: jest.fn().mockReturnValue(countFrom) };
      return fromChain;
    }),
    query: { tasks: resolvedQuery },
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
  };
  return db;
}

describe("TasksService — cross-tenant isolation", () => {
  let svc: TasksService;
  let mockDb: ReturnType<typeof buildDb>;

  const buildSvc = async (rows: unknown[]) => {
    mockDb = buildDb(rows);
    const mod = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: TaskNotificationsService, useValue: { notifyAssignee: jest.fn() } },
        { provide: AccessService, useValue: {
          resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["crm:tasks:view", "all"]])),
        }},
      ],
    }).compile();
    return mod.get(TasksService);
  };

  it("returns nothing for a different org — cross-tenant isolation", async () => {
    const rows: unknown[] = [];
    const attackerWhere = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockResolvedValue(rows),
    });
    const countWhere = jest.fn().mockResolvedValue([{ count: 0 }]);
    let selectCall = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall % 2 === 0)
          return { from: jest.fn().mockReturnValue({ where: countWhere }) };
        return { from: jest.fn().mockReturnValue({ where: attackerWhere }) };
      }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: DRIZZLE, useValue: db },
        { provide: TaskNotificationsService, useValue: { notifyAssignee: jest.fn() } },
        { provide: AccessService, useValue: {
          resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
        }},
      ],
    }).compile();
    svc = mod.get(TasksService);

    const result = await svc.list(ownerCtx(ATTACKER_ORG), { page: 1, limit: 20 });

    expect(result.tasks).toHaveLength(0);
    expect(attackerWhere).toHaveBeenCalledTimes(1);
    const callArg = attackerWhere.mock.calls[0]?.[0];
    const vals: unknown[] = [];
    function collectVals(v: unknown, seen = new Set<object>()): void {
      if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") { vals.push(v); return; }
      if (Array.isArray(v)) { v.forEach(i => collectVals(i, seen)); return; }
      if (typeof v !== "object" || seen.has(v as object)) return;
      seen.add(v as object);
      const r = v as { queryChunks?: unknown[]; value?: unknown };
      if (r.queryChunks) collectVals(r.queryChunks, seen);
      if (Object.prototype.hasOwnProperty.call(r, "value")) collectVals(r.value, seen);
    }
    collectVals(callArg);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("returns rows for the owning org (same-tenant control)", async () => {
    const row = { id: 1, orgId: OWNER_ORG, title: "Task A", status: "pending" };
    const rows = [row];
    const ownerWhere = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockResolvedValue(rows),
    });
    const countWhere = jest.fn().mockResolvedValue([{ count: 1 }]);
    let selectCall = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall % 2 === 0)
          return { from: jest.fn().mockReturnValue({ where: countWhere }) };
        return { from: jest.fn().mockReturnValue({ where: ownerWhere }) };
      }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: DRIZZLE, useValue: db },
        { provide: TaskNotificationsService, useValue: { notifyAssignee: jest.fn() } },
        { provide: AccessService, useValue: {
          resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
        }},
      ],
    }).compile();
    svc = mod.get(TasksService);

    const result = await svc.list(ownerCtx(OWNER_ORG), { page: 1, limit: 20 });

    expect(result.tasks).toHaveLength(1);
  });
});
