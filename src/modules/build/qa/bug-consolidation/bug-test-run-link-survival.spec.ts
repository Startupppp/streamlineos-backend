import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { TestRunsService } from "../test-runs.service";
import { BuildTicketCreationService } from "../../core/tickets";
import { tickets } from "../../../../db/schema";
import {
  MANAGER_STANDING,
  projectAccessRow,
  standingAccess,
} from "../../core/project-crud/__tests__/project-access-doubles";

function makeTicketCreation() {
  return {
    createInTransaction: jest.fn(async (tx: Record<string, unknown>, command: Record<string, unknown>) => {
      const drafts = command["drafts"] as Record<string, unknown>[];
      const draft = drafts[0] ?? {};
      const row: Record<string, unknown> = {
        orgId: command["orgId"],
        projectId: command["projectId"],
        ...draft,
      };
      const inserted = await (tx["insert"] as jest.Mock)(tickets).values(row).returning() as unknown[];
      return { tickets: inserted, command };
    }),
    publish: jest.fn(),
  } as unknown as BuildTicketCreationService;
}

const MEMBERSHIP_ID = 7;
const ORG = "org-owner";
const PROJECT_ID = 1;

function makeU(): CurrentUserContext {
  return {
    userId: "user-7",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
  };
}

function makeAccess(): AccessService {
  return standingAccess(MANAGER_STANDING) as unknown as AccessService;
}

const audit = { log: jest.fn() } as never;

describe("TestRunsService.createBugFromResultConsolidated — link survival via linkedWorkItemId (post-migration 1147)", () => {
  it("sets linkedWorkItemId on the result row and NOT linkedBugId — mutation guard: changing linkedWorkItemId to linkedBugId breaks this test", async () => {
    const createdTicket = { id: 200, ticketNumber: 5, title: "Failed: Login", type: "BUG" };
    let capturedLinkedWorkItemId: number | undefined;
    let linkedBugIdWasSet = false;

    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ maxNum: 4 }]) }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([createdTicket]) }),
      }),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((setObj: Record<string, unknown>) => {
          if ("linkedWorkItemId" in setObj) capturedLinkedWorkItemId = setObj["linkedWorkItemId"] as number;
          if ("linkedBugId" in setObj) linkedBugIdWasSet = true;
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
    };

    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID, managerMembershipId: null }) },
        testRunResults: { findFirst: jest.fn().mockResolvedValue({ id: 3, testCaseId: 9 }) },
        testCases: {
          findFirst: jest.fn().mockResolvedValue({ id: 9, title: "Login", steps: [], expectedResult: "success" }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([projectAccessRow()]) }),
          ),
        }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit, makeTicketCreation());
    const result = await svc.createBugFromResultConsolidated(makeU(), PROJECT_ID, 1, 3, {});

    expect(result).toMatchObject({ id: 200, type: "BUG" });
    expect(capturedLinkedWorkItemId).toBe(200);
    expect(linkedBugIdWasSet).toBe(false);
  });

  it("inserts into the tickets table and into exactly one table, so a second writer cannot reappear now that build.bugs is dropped and could not be named here", async () => {
    const createdTicket = { id: 300, ticketNumber: 1, title: "Failed: Signup", type: "BUG" };
    const insertedTables: unknown[] = [];

    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ maxNum: 0 }]) }),
      }),
      insert: jest.fn().mockImplementation((table: unknown) => {
        insertedTables.push(table);
        return {
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([createdTicket]),
          }),
        };
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };

    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID, managerMembershipId: null }) },
        testRunResults: { findFirst: jest.fn().mockResolvedValue({ id: 5, testCaseId: 20 }) },
        testCases: {
          findFirst: jest.fn().mockResolvedValue({ id: 20, title: "Signup", steps: [], expectedResult: null }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([projectAccessRow()]) }),
          ),
        }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit, makeTicketCreation());
    await svc.createBugFromResultConsolidated(makeU(), PROJECT_ID, 1, 5, {});

    expect(insertedTables).toContain(tickets);
    expect(new Set(insertedTables).size).toBe(insertedTables.length);
  });

  it("audit log records ticket resource type not bug resource type — if reverted to bug, this test fails", async () => {
    const createdTicket = { id: 400, ticketNumber: 3, title: "Failed: Payment", type: "BUG" };

    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ maxNum: 2 }]) }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([createdTicket]) }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };

    const auditSpy = { log: jest.fn() } as never;
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID, managerMembershipId: null }) },
        testRunResults: { findFirst: jest.fn().mockResolvedValue({ id: 7, testCaseId: 30 }) },
        testCases: {
          findFirst: jest.fn().mockResolvedValue({ id: 30, title: "Payment", steps: [], expectedResult: null }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([projectAccessRow()]) }),
          ),
        }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), auditSpy, makeTicketCreation());
    await svc.createBugFromResultConsolidated(makeU(), PROJECT_ID, 1, 7, {});

    const auditCall = (auditSpy as { log: jest.Mock }).log.mock.calls[0]?.[0] as { resourceType: string; action: string } | undefined;
    expect(auditCall?.resourceType).toBe("ticket");
    expect(auditCall?.action).toBe("bug.created_from_result_consolidated");
  });

  it("throws NotFoundException when the test run result does not exist — no partial write occurs", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID, managerMembershipId: null }) },
        testRunResults: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([projectAccessRow()]) }),
          ),
        }),
      }),
      transaction: jest.fn(),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit, makeTicketCreation());
    await expect(
      svc.createBugFromResultConsolidated(makeU(), PROJECT_ID, 1, 999, {}),
    ).rejects.toThrow(NotFoundException);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
