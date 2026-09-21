import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TestRunsService } from "./test-runs.service";

const MEMBERSHIP_ID = 7;

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-7",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, isOrgOwner),
  };
}

function makeAccess() {
  return { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;
}

describe("TestRunsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;

  function makeDb(runRow: unknown | null) {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) });
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ innerJoin });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        testRuns: { findFirst: jest.fn().mockResolvedValue(runRow) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  it("throws NotFoundException for getRun when run belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new TestRunsService(db, makeAccess(), audit);
    await expect(svc.getRun(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns run for the owning org (same-tenant control)", async () => {
    const run = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Run 1" };
    const db = makeDb(run);
    const svc = new TestRunsService(db, makeAccess(), audit);
    const result = await svc.getRun(OWNER_ORG, 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe("TestRunsService — project membership gate (assertProjectAccess)", () => {
  const audit = { log: jest.fn() } as never;

  function makeNonMemberDb() {
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
    const from = jest.fn().mockReturnValue({ innerJoin, where });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        testRuns: { findFirst: jest.fn() },
        testRunResults: { findFirst: jest.fn() },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  function makeMemberDb() {
    let callCount = 0;
    const makeLimitChain = (rows: unknown[]) => {
      const limit = jest.fn().mockResolvedValue(rows);
      const where = jest.fn().mockReturnValue({ limit });
      const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
      return { from: jest.fn().mockReturnValue({ innerJoin, where }) };
    };
    const runsChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        testRuns: { findFirst: jest.fn() },
        testRunResults: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? makeLimitChain([{ role: "MEMBER" }]) : runsChain;
      }),
    } as unknown as Db;
  }

  it("rejects a non-member with ForbiddenException", async () => {
    const db = makeNonMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new TestRunsService(db, access, audit);
    await expect(svc.listRuns(makeU("org-1"), 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member through the gate", async () => {
    const db = makeMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new TestRunsService(db, access, audit);
    await expect(svc.listRuns(makeU("org-1"), 1, {})).resolves.toEqual({
      data: [],
      hasMore: false,
      nextCursor: null,
    });
  });
});

describe("TestRunsService — listRuns cursor pagination", () => {
  const OWNER_ORG = "org-owner";
  const audit = { log: jest.fn() } as never;

  it("returns only runs after the cursor id when cursor is provided", async () => {
    const runAfterCursor = {
      id: 8, orgId: OWNER_ORG, projectId: 1, name: "Run 8", runNumber: 8,
      status: "not_started", sprintId: null, releaseId: null, environment: null,
      browserDevice: null, testerId: null, testerMembershipId: null, startedAt: null,
      completedAt: null, createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      deletedAt: null,
    };

    let selectCall = 0;
    const runsChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([runAfterCursor]),
          }),
        }),
      }),
    };
    const countsChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          groupBy: jest.fn().mockResolvedValue([{ runId: 8, total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, notRun: 0 }]),
        }),
      }),
    };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, managerMembershipId: null }) },
        testRuns: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        return selectCall === 1 ? runsChain : countsChain;
      }),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    const result = await svc.listRuns(makeU(OWNER_ORG), 1, { cursor: 7 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: 8 });
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

describe("TestRunsService — listRunResults cross-tenant isolation", () => {
  const audit = { log: jest.fn() } as never;

  it("throws NotFoundException when run belongs to a different org", async () => {
    const db = {
      query: {
        testRuns: { findFirst: jest.fn().mockResolvedValue(null) },
        projects: { findFirst: jest.fn() },
      },
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    await expect(svc.listRunResults("org-attacker", 1, 99, { limit: 50 })).rejects.toThrow(NotFoundException);
  });

  it("returns empty page when run has no results", async () => {
    const run = { id: 1, orgId: "org-owner", projectId: 1, name: "Run 1" };
    const resultsChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const db = {
      query: {
        testRuns: { findFirst: jest.fn().mockResolvedValue(run) },
        projects: { findFirst: jest.fn() },
      },
      select: jest.fn().mockReturnValue(resultsChain),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    const page = await svc.listRunResults("org-owner", 1, 1, { limit: 50 });

    expect(page).toMatchObject({ data: [], hasMore: false, nextCursor: null });
  });
});

describe("TestRunsService — updateResult idempotency", () => {
  const audit = { log: jest.fn() } as never;

  function makeResultDb(existingResult: unknown) {
    return {
      query: {
        testRunResults: { findFirst: jest.fn().mockResolvedValue(existingResult) },
        testRuns: { findFirst: jest.fn() },
        projects: { findFirst: jest.fn() },
      },
      update: jest.fn(),
    } as unknown as Db;
  }

  it("skips the DB write when status and notes match the existing row", async () => {
    const existingResult = {
      id: 1,
      orgId: "org-1",
      projectId: 1,
      runId: 1,
      testCaseId: 1,
      status: "passed",
      notes: "looks good",
      executedBy: "user-1",
      executedAt: new Date(),
      linkedBugId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const db = makeResultDb(existingResult);
    const svc = new TestRunsService(db, makeAccess(), audit);
    const result = await svc.updateResult("org-1", 1, 1, 1, { status: "passed", notes: "looks good" }, "user-2");

    expect(db.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 1, status: "passed" });
  });

  it("proceeds with write when status differs from existing row", async () => {
    const existingResult = {
      id: 1,
      orgId: "org-1",
      projectId: 1,
      runId: 1,
      testCaseId: 1,
      status: "not_run",
      notes: null,
      executedBy: null,
      executedAt: null,
      linkedBugId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const updatedResult = { ...existingResult, status: "passed", notes: null, executedBy: "user-2" };
    const returningMock = jest.fn().mockResolvedValue([updatedResult]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    const updateMock = jest.fn().mockReturnValue({ set: setMock });

    const db = {
      query: {
        testRunResults: { findFirst: jest.fn().mockResolvedValue(existingResult) },
        testRuns: { findFirst: jest.fn() },
        projects: { findFirst: jest.fn() },
      },
      update: updateMock,
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    const result = await svc.updateResult("org-1", 1, 1, 1, { status: "passed" }, "user-2");

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "passed" });
  });

  it("throws NotFoundException when result does not belong to the specified run", async () => {
    const db = {
      query: {
        testRunResults: { findFirst: jest.fn().mockResolvedValue(null) },
        testRuns: { findFirst: jest.fn() },
        projects: { findFirst: jest.fn() },
      },
      update: jest.fn(),
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    await expect(
      svc.updateResult("org-1", 1, 99, 1, { status: "passed" }, "user-2"),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("TestRunsService — run completion atomicity", () => {
  const audit = { log: jest.fn() } as never;

  it("sets completedAt only on the first transition to completed status", async () => {
    const existing = {
      id: 1,
      status: "in_progress",
      startedAt: new Date(),
      completedAt: null,
    };
    const updatedRow = { id: 1, status: "completed", completedAt: new Date() };
    const returningMock = jest.fn().mockResolvedValue([updatedRow]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    const updateMock = jest.fn().mockReturnValue({ set: setMock });

    const db = {
      query: {
        testRuns: { findFirst: jest.fn().mockResolvedValue(existing) },
        projects: { findFirst: jest.fn() },
      },
      update: updateMock,
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    const result = await svc.updateRun("org-1", "user-1", 1, 1, { status: "completed" });

    expect(setMock).toHaveBeenCalledTimes(1);
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("completedAt");
    expect(result).toMatchObject({ status: "completed" });
  });

  it("does not overwrite completedAt when run is already completed", async () => {
    const alreadyCompleted = new Date("2026-09-01T10:00:00.000Z");
    const existing = {
      id: 1,
      status: "completed",
      startedAt: new Date(),
      completedAt: alreadyCompleted,
    };
    const returningMock = jest.fn().mockResolvedValue([existing]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    const updateMock = jest.fn().mockReturnValue({ set: setMock });

    const db = {
      query: {
        testRuns: { findFirst: jest.fn().mockResolvedValue(existing) },
        projects: { findFirst: jest.fn() },
      },
      update: updateMock,
    } as unknown as Db;

    const svc = new TestRunsService(db, makeAccess(), audit);
    await svc.updateRun("org-1", "user-1", 1, 1, { status: "completed" });

    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty("completedAt");
  });
});
