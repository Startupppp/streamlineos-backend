import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TestManagementService } from "./test-management.service";
import { TestRunsService } from "./test-runs.service";

const MEMBERSHIP_ID = 7;
const ORG = "org-1";
const PROJECT_ID = 7;
const OTHER_MANAGER_MEMBERSHIP_ID = 999;

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

function makeAccessWithoutBuildManage() {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  } as unknown as AccessService;
}

const audit = { log: jest.fn() } as never;

function membershipProbe(rows: Array<{ role: string }>) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest
    .fn()
    .mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
  return { from: jest.fn().mockReturnValue({ innerJoin, where }) };
}

function updateChain(returned: unknown[]) {
  const returning = jest.fn().mockResolvedValue(returned);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  return jest.fn().mockReturnValue({ set });
}

function softDeleteChain() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  return jest.fn().mockReturnValue({ set });
}

interface DeniedDb {
  db: Db;
  rowFindFirst: jest.Mock;
  update: jest.Mock;
  insert: jest.Mock;
  transaction: jest.Mock;
}

function makeNonMemberDb(): DeniedDb {
  const rowFindFirst = jest.fn();
  const update = jest.fn();
  const insert = jest.fn();
  const transaction = jest.fn();
  const db = {
    query: {
      projects: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
      },
      testSuites: { findFirst: rowFindFirst },
      testCases: { findFirst: rowFindFirst },
      testRuns: { findFirst: rowFindFirst },
      testRunResults: { findFirst: rowFindFirst },
    },
    select: jest.fn().mockImplementation(() => membershipProbe([])),
    update,
    insert,
    transaction,
  } as unknown as Db;
  return { db, rowFindFirst, update, insert, transaction };
}

function memberSelect(bodyChains: Array<() => unknown>) {
  let call = 0;
  return jest.fn().mockImplementation(() => {
    call += 1;
    if (call === 1) return membershipProbe([{ role: "MEMBER" }]);
    const chain = bodyChains[call - 2];
    return chain ? chain() : membershipProbe([]);
  });
}

describe("TestManagementService — by-id routes gate on project membership, not only orgId", () => {
  it("refuses getCase for an in-tenant non-member of the project before it reads the row", async () => {
    const { db, rowFindFirst } = makeNonMemberDb();
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(svc.getCase(makeU(), PROJECT_ID, 42)).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
  });

  it("returns the case to a project member (control for the getCase denial)", async () => {
    const testCaseRow = { id: 42, orgId: ORG, projectId: PROJECT_ID, title: "Login" };
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testCases: { findFirst: jest.fn().mockResolvedValue(testCaseRow) },
      },
      select: memberSelect([]),
    } as unknown as Db;
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(svc.getCase(makeU(), PROJECT_ID, 42)).resolves.toMatchObject({ id: 42 });
  });

  it("refuses updateCase for an in-tenant non-member of the project before it writes", async () => {
    const { db, rowFindFirst, update } = makeNonMemberDb();
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(
      svc.updateCase(makeU(), PROJECT_ID, 42, { title: "hijacked" }),
    ).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("updates the case for a project member (control for the updateCase denial)", async () => {
    const update = updateChain([{ id: 42, title: "renamed" }]);
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testCases: { findFirst: jest.fn().mockResolvedValue({ id: 42 }) },
      },
      select: memberSelect([]),
      update,
    } as unknown as Db;
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(svc.updateCase(makeU(), PROJECT_ID, 42, { title: "renamed" })).resolves.toMatchObject({
      id: 42,
      title: "renamed",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses deleteCase for an in-tenant non-member of the project before it writes", async () => {
    const { db, rowFindFirst, update } = makeNonMemberDb();
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(svc.deleteCase(makeU(), PROJECT_ID, 42)).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("deletes the case for a project member (control for the deleteCase denial)", async () => {
    const update = softDeleteChain();
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testCases: { findFirst: jest.fn().mockResolvedValue({ id: 42 }) },
      },
      select: memberSelect([]),
      update,
    } as unknown as Db;
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(svc.deleteCase(makeU(), PROJECT_ID, 42)).resolves.toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses updateSuite for an in-tenant non-member of the project before it writes", async () => {
    const { db, rowFindFirst, update } = makeNonMemberDb();
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(
      svc.updateSuite(makeU(), PROJECT_ID, 11, { name: "hijacked" }),
    ).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("updates the suite for a project member (control for the updateSuite denial)", async () => {
    const update = updateChain([{ id: 11, name: "renamed" }]);
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testSuites: { findFirst: jest.fn().mockResolvedValue({ id: 11 }) },
      },
      select: memberSelect([]),
      update,
    } as unknown as Db;
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(svc.updateSuite(makeU(), PROJECT_ID, 11, { name: "renamed" })).resolves.toMatchObject({
      id: 11,
      name: "renamed",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses deleteSuite for an in-tenant non-member of the project before it writes", async () => {
    const { db, rowFindFirst, update } = makeNonMemberDb();
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(svc.deleteSuite(makeU(), PROJECT_ID, 11)).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("deletes the suite for a project member (control for the deleteSuite denial)", async () => {
    const update = softDeleteChain();
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testSuites: { findFirst: jest.fn().mockResolvedValue({ id: 11 }) },
      },
      select: memberSelect([]),
      update,
    } as unknown as Db;
    const svc = new TestManagementService(db, makeAccessWithoutBuildManage());

    await expect(svc.deleteSuite(makeU(), PROJECT_ID, 11)).resolves.toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("TestRunsService — by-id routes gate on project membership, not only orgId", () => {
  it("refuses getRun for an in-tenant non-member of the project before it reads the row", async () => {
    const { db, rowFindFirst } = makeNonMemberDb();
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(svc.getRun(makeU(), PROJECT_ID, 5)).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
  });

  it("returns the run to a project member (control for the getRun denial)", async () => {
    const resultsChain = () => ({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    });
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testRuns: { findFirst: jest.fn().mockResolvedValue({ id: 5, name: "Run 5" }) },
      },
      select: memberSelect([resultsChain]),
    } as unknown as Db;
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(svc.getRun(makeU(), PROJECT_ID, 5)).resolves.toMatchObject({ id: 5, results: [] });
  });

  it("refuses listRunResults for an in-tenant non-member of the project before it reads the rows", async () => {
    const { db, rowFindFirst } = makeNonMemberDb();
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(svc.listRunResults(makeU(), PROJECT_ID, 5, { limit: 50 })).rejects.toThrow(
      ForbiddenException,
    );
    expect(rowFindFirst).not.toHaveBeenCalled();
  });

  it("returns run results to a project member (control for the listRunResults denial)", async () => {
    const rowsChain = () => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    });
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testRuns: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
      },
      select: memberSelect([rowsChain]),
    } as unknown as Db;
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(svc.listRunResults(makeU(), PROJECT_ID, 5, { limit: 50 })).resolves.toMatchObject({
      data: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("refuses updateRun for an in-tenant non-member of the project before it writes", async () => {
    const { db, rowFindFirst, update } = makeNonMemberDb();
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(svc.updateRun(makeU(), PROJECT_ID, 5, { name: "hijacked" })).rejects.toThrow(
      ForbiddenException,
    );
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("updates the run for a project member (control for the updateRun denial)", async () => {
    const update = updateChain([{ id: 5, name: "renamed" }]);
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testRuns: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 5, status: "in_progress", startedAt: new Date(), completedAt: null }),
        },
      },
      select: memberSelect([]),
      update,
    } as unknown as Db;
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(svc.updateRun(makeU(), PROJECT_ID, 5, { name: "renamed" })).resolves.toMatchObject({
      id: 5,
      name: "renamed",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses deleteRun for an in-tenant non-member of the project before it writes", async () => {
    const { db, rowFindFirst, update } = makeNonMemberDb();
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(svc.deleteRun(makeU(), PROJECT_ID, 5)).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("deletes the run for a project member (control for the deleteRun denial)", async () => {
    const update = softDeleteChain();
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testRuns: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
      },
      select: memberSelect([]),
      update,
    } as unknown as Db;
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(svc.deleteRun(makeU(), PROJECT_ID, 5)).resolves.toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses updateResult for an in-tenant non-member of the project before it writes", async () => {
    const { db, rowFindFirst, update } = makeNonMemberDb();
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(
      svc.updateResult(makeU(), PROJECT_ID, 5, 3, { status: "passed" }),
    ).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("records the result for a project member (control for the updateResult denial)", async () => {
    const update = updateChain([{ id: 3, status: "passed", executedBy: "user-7" }]);
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testRunResults: {
          findFirst: jest.fn().mockResolvedValue({ id: 3, status: "not_run", notes: null }),
        },
      },
      select: memberSelect([]),
      update,
    } as unknown as Db;
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(svc.updateResult(makeU(), PROJECT_ID, 5, 3, { status: "passed" })).resolves.toMatchObject(
      { id: 3, status: "passed", executedBy: "user-7" },
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses createBugFromResultConsolidated for an in-tenant non-member of the project before it opens a transaction", async () => {
    const { db, rowFindFirst, transaction } = makeNonMemberDb();
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(
      svc.createBugFromResultConsolidated(makeU(), PROJECT_ID, 5, 3, { description: "broken" }),
    ).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("files the bug for a project member (control for the createBugFromResultConsolidated denial)", async () => {
    const createdTicket = { id: 88, ticketNumber: 1, title: "Failed: Login", type: "BUG" };
    const txInsert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([createdTicket]) }),
    });
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ maxNum: 0 }]) }),
      }),
      insert: txInsert,
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    const transaction = jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        testRunResults: { findFirst: jest.fn().mockResolvedValue({ id: 3, testCaseId: 9 }) },
        testCases: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 9, title: "Login", steps: [], expectedResult: "works" }),
        },
      },
      select: memberSelect([
        () => ({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      ]),
      transaction,
    } as unknown as Db;
    const svc = new TestRunsService(db, makeAccessWithoutBuildManage(), audit);

    await expect(
      svc.createBugFromResultConsolidated(makeU(), PROJECT_ID, 5, 3, { description: "broken" }),
    ).resolves.toMatchObject({ id: 88, type: "BUG" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(2);
  });
});
