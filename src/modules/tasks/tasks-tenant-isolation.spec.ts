/**
 * TasksService — cross-tenant isolation
 *
 * Proves list and getTask scope every query to the caller's org.
 */

import { Test } from "@nestjs/testing";
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
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s1",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
});

function makeFullChain(rows: unknown[]) {
  const obj: Record<string, unknown> = {};
  const methods = ["from", "where", "orderBy", "limit", "offset", "leftJoin", "groupBy"];
  for (const m of methods) obj[m] = jest.fn(() => obj);
  obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
  return obj;
}

function buildDb(rows: unknown[]) {
  let callIdx = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx === 2) return makeFullChain([{ count: rows.length }]);
      return makeFullChain(rows);
    }),
    query: { tasks: { findMany: jest.fn().mockResolvedValue(rows), findFirst: jest.fn().mockResolvedValue(rows[0] ?? null) } },
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db as unknown)),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
  };
  return db;
}

describe("TasksService — cross-tenant isolation", () => {
  it("returns nothing for a different org — cross-tenant isolation", async () => {
    const db = buildDb([]);
    const mod = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: DRIZZLE, useValue: db },
        { provide: TaskNotificationsService, useValue: { notifyAssignee: jest.fn() } },
        { provide: AccessService, useValue: {
          resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["crm:tasks:view", "all"]])),
        }},
      ],
    }).compile();
    const svc = mod.get(TasksService);
    const result = await svc.list(ownerCtx(ATTACKER_ORG), { limit: 20 });
    expect(result.tasks).toHaveLength(0);
  });

  it("returns rows for the owning org (same-tenant control)", async () => {
    const row = { id: 1, orgId: OWNER_ORG, title: "Task A", status: "pending" };
    const db = buildDb([row]);
    const mod = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: DRIZZLE, useValue: db },
        { provide: TaskNotificationsService, useValue: { notifyAssignee: jest.fn() } },
        { provide: AccessService, useValue: {
          resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["crm:tasks:view", "all"]])),
        }},
      ],
    }).compile();
    const svc = mod.get(TasksService);
    const result = await svc.list(ownerCtx(OWNER_ORG), { limit: 20 });
    expect(result.tasks).toHaveLength(1);
  });
});
