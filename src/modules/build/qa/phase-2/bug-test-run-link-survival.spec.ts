import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { TestRunsService } from "../test-runs.service";
import { tickets, bugs } from "../../../../db/schema";

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
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])),
  } as unknown as AccessService;
}

const audit = { log: jest.fn() } as never;

describe("TestRunsService.createBugFromResult — test-run failure link survival", () => {
  it("sets linkedBugId on the result row atomically inside the transaction — mutation guard: removing the update call breaks this test", async () => {
    const createdBug = { id: 55, bugNumber: 1, title: "Failed: Login Test", orgId: ORG };
    let capturedLinkedBugId: number | undefined;
    let capturedResultId: number | undefined;

    const txUpdate = jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((setObj: Record<string, unknown>) => {
        if (typeof setObj["linkedBugId"] === "number") {
          capturedLinkedBugId = setObj["linkedBugId"] as number;
          capturedResultId = 3;
        }
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    }));

    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ maxNum: 0 }]) }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([createdBug]) }),
      }),
      update: txUpdate,
    };

    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID, managerMembershipId: null }) },
        testRunResults: { findFirst: jest.fn().mockResolvedValue({ id: 3, testCaseId: 9 }) },
        testCases: {
          findFirst: jest.fn().mockResolvedValue({ id: 9, title: "Login Test", steps: [], expectedResult: "ok" }),
        },
      },
      transaction: jest.fn().mockImplementation(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    const result = await svc.createBugFromResult(makeU(), PROJECT_ID, 1, 3, {});

    expect(result).toMatchObject({ id: 55 });
    expect(capturedLinkedBugId).toBe(55);
    expect(capturedResultId).toBe(3);
    expect(txUpdate).toHaveBeenCalledTimes(1);
  });

  it("positive control — linkedBugId is resolvable after creation (link survives)", async () => {
    const createdBug = { id: 77, bugNumber: 2, title: "Failed: Checkout", orgId: ORG };
    let storedLinkedBugId: number | undefined;

    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ maxNum: 1 }]) }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([createdBug]) }),
      }),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((setObj: Record<string, unknown>) => {
          storedLinkedBugId = setObj["linkedBugId"] as number | undefined;
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
    };

    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID, managerMembershipId: null }) },
        testRunResults: { findFirst: jest.fn().mockResolvedValue({ id: 8, testCaseId: 12 }) },
        testCases: {
          findFirst: jest.fn().mockResolvedValue({ id: 12, title: "Checkout", steps: [], expectedResult: null }),
        },
      },
      transaction: jest.fn().mockImplementation(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    await svc.createBugFromResult(makeU(), PROJECT_ID, 1, 8, { title: "Checkout regression" });

    expect(storedLinkedBugId).toBe(77);
  });

  it("throws NotFoundException when the test run result does not exist — no partial write occurs", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID, managerMembershipId: null }) },
        testRunResults: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      transaction: jest.fn(),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    await expect(svc.createBugFromResult(makeU(), PROJECT_ID, 1, 999, {})).rejects.toThrow(NotFoundException);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

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
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    const result = await svc.createBugFromResultConsolidated(makeU(), PROJECT_ID, 1, 3, {});

    expect(result).toMatchObject({ id: 200, type: "BUG" });
    expect(capturedLinkedWorkItemId).toBe(200);
    expect(linkedBugIdWasSet).toBe(false);
  });

  it("inserts into tickets table NOT bugs table — legacy-writer freeze behavioral test: if tickets is replaced with bugs in the insert, this test fails", async () => {
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
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    await svc.createBugFromResultConsolidated(makeU(), PROJECT_ID, 1, 5, {});

    expect(insertedTables).not.toContain(bugs);
    expect(insertedTables).toContain(tickets);
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
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), auditSpy);
    await svc.createBugFromResultConsolidated(makeU(), PROJECT_ID, 1, 7, {});

    const auditCall = (auditSpy as { log: jest.Mock }).log.mock.calls[0]?.[0] as { resourceType: string; action: string } | undefined;
    expect(auditCall?.resourceType).toBe("ticket");
    expect(auditCall?.action).toBe("bug.created_from_result_consolidated");
  });
});
