import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { TestRunsService } from "../test-runs.service";
import { cycles, testRuns } from "../../../../db/schema";

const ORG = "org-1";
const PROJECT_ID = 4;
const MEMBERSHIP_ID = 7;

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

interface SelectCall {
  table: unknown;
  projection: unknown;
}

function sequencedSelect(results: unknown[][], calls: SelectCall[]) {
  let index = 0;
  return jest.fn().mockImplementation((projection?: unknown) => {
    const rows = results[index] ?? [];
    index += 1;
    const terminal = {
      where: jest.fn().mockImplementation(() => ({
        limit: jest.fn().mockResolvedValue(rows),
        groupBy: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      })),
    };
    return {
      from: jest.fn().mockImplementation((table: unknown) => {
        calls.push({ table, projection });
        return { ...terminal, innerJoin: jest.fn().mockReturnValue(terminal) };
      }),
    };
  });
}

function createRunDb(selectResults: unknown[][], calls: SelectCall[], created: unknown) {
  const insertedValues: Record<string, unknown>[] = [];
  const insertedTables: unknown[] = [];
  const tx = {
    execute: jest.fn().mockResolvedValue(undefined),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ maxNum: 0 }]) }),
    }),
    insert: jest.fn().mockImplementation((table: unknown) => {
      insertedTables.push(table);
      return {
        values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
          insertedValues.push(v);
          return { returning: jest.fn().mockResolvedValue([created]) };
        }),
      };
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
  };
  const transaction = jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
  const db = {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
    },
    select: sequencedSelect(selectResults, calls),
    transaction,
  } as unknown as Db;
  return { db, transaction, insertedValues, insertedTables };
}

describe("createRun binds a test run to a cycle and never writes test_runs.sprint_id", () => {
  it("resolves a legacy sprintId through cycles.legacy_sprint_id and writes cycleId — mutation guard: restoring sprintId on the insert fails this test", async () => {
    const calls: SelectCall[] = [];
    const { db, insertedValues, insertedTables } = createRunDb(
      [[{ id: 31, legacySprintId: 9 }]],
      calls,
      { id: 1, runNumber: 1, name: "Regression", cycleId: 31 },
    );
    const svc = new TestRunsService(db, makeAccess(), audit);

    await svc.createRun(makeU(), PROJECT_ID, { name: "Regression", sprintId: 9 });

    expect(calls[0]?.table).toBe(cycles);
    const runValues = insertedValues[insertedTables.indexOf(testRuns)]!;
    expect(runValues["cycleId"]).toBe(31);
    expect(Object.keys(runValues)).not.toContain("sprintId");
  });

  it("still emits sprintId on the response, derived from the cycle, so the wire contract survives the cutover", async () => {
    const calls: SelectCall[] = [];
    const { db } = createRunDb([[{ id: 31, legacySprintId: 9 }]], calls, {
      id: 1,
      runNumber: 1,
      name: "Regression",
      cycleId: 31,
    });
    const svc = new TestRunsService(db, makeAccess(), audit);

    const run = await svc.createRun(makeU(), PROJECT_ID, { name: "Regression", sprintId: 9 });

    expect(run).toMatchObject({ cycleId: 31, sprintId: 9 });
  });

  it("accepts cycleId as canonical input and reports that cycle's legacy sprint as sprintId", async () => {
    const calls: SelectCall[] = [];
    const { db, insertedValues, insertedTables } = createRunDb(
      [[{ id: 44, legacySprintId: 12 }]],
      calls,
      { id: 2, runNumber: 1, name: "Smoke", cycleId: 44 },
    );
    const svc = new TestRunsService(db, makeAccess(), audit);

    const run = await svc.createRun(makeU(), PROJECT_ID, { name: "Smoke", cycleId: 44 });

    expect(insertedValues[insertedTables.indexOf(testRuns)]!["cycleId"]).toBe(44);
    expect(run).toMatchObject({ sprintId: 12 });
  });

  it("rejects a sprintId that maps to no cycle before it opens a transaction, rather than writing a dangling run", async () => {
    const calls: SelectCall[] = [];
    const { db, transaction } = createRunDb([[]], calls, {});
    const svc = new TestRunsService(db, makeAccess(), audit);

    await expect(
      svc.createRun(makeU(), PROJECT_ID, { name: "Regression", sprintId: 404 }),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects a cycleId that does not exist in the tenant before it opens a transaction", async () => {
    const calls: SelectCall[] = [];
    const { db, transaction } = createRunDb([[]], calls, {});
    const svc = new TestRunsService(db, makeAccess(), audit);

    await expect(
      svc.createRun(makeU(), PROJECT_ID, { name: "Regression", cycleId: 909 }),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("issues no cycle lookup and writes a null cycleId when neither sprintId nor cycleId is supplied", async () => {
    const calls: SelectCall[] = [];
    const { db, insertedValues, insertedTables } = createRunDb([], calls, {
      id: 3,
      runNumber: 1,
      name: "Ad hoc",
      cycleId: null,
    });
    const svc = new TestRunsService(db, makeAccess(), audit);

    const run = await svc.createRun(makeU(), PROJECT_ID, { name: "Ad hoc" });

    expect(calls.filter((c) => c.table === cycles)).toHaveLength(0);
    expect(insertedValues[insertedTables.indexOf(testRuns)]!["cycleId"]).toBeNull();
    expect(run).toMatchObject({ sprintId: null });
  });
});

describe("updateRun rebinds the cycle and never writes test_runs.sprint_id", () => {
  function updateDb(cycleRows: unknown[], updated: unknown) {
    const setObjects: Record<string, unknown>[] = [];
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
        testRuns: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 5, status: "in_progress", startedAt: new Date(), completedAt: null }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(cycleRows) }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((setObj: Record<string, unknown>) => {
          setObjects.push(setObj);
          return { where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([updated]) }) };
        }),
      }),
    } as unknown as Db;
    return { db, setObjects };
  }

  it("translates an incoming sprintId into a cycleId on the SET clause — mutation guard: a SET of sprintId fails this test", async () => {
    const { db, setObjects } = updateDb([{ id: 31, legacySprintId: 9 }], { id: 5, cycleId: 31 });
    const svc = new TestRunsService(db, makeAccess(), audit);

    const updated = await svc.updateRun(makeU(), PROJECT_ID, 5, { sprintId: 9 });

    expect(setObjects[0]!["cycleId"]).toBe(31);
    expect(Object.keys(setObjects[0]!)).not.toContain("sprintId");
    expect(updated).toMatchObject({ sprintId: 9, cycleId: 31 });
  });

  it("leaves the cycle binding untouched when neither sprintId nor cycleId is in the patch", async () => {
    const { db, setObjects } = updateDb([{ id: 31, legacySprintId: 9 }], { id: 5, cycleId: 31 });
    const svc = new TestRunsService(db, makeAccess(), audit);

    await svc.updateRun(makeU(), PROJECT_ID, 5, { name: "Renamed" });

    expect(Object.keys(setObjects[0]!)).not.toContain("cycleId");
    expect(Object.keys(setObjects[0]!)).not.toContain("sprintId");
  });

  it("rejects a sprintId that maps to no cycle rather than silently clearing the binding", async () => {
    const { db } = updateDb([], { id: 5, cycleId: null });
    const svc = new TestRunsService(db, makeAccess(), audit);

    await expect(svc.updateRun(makeU(), PROJECT_ID, 5, { sprintId: 404 })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("reads report sprintId from the cycle, not from the legacy test_runs.sprint_id column", () => {
  it("overrides a stale stored sprint_id with the bridged legacy sprint of the run's cycle", async () => {
    const calls: SelectCall[] = [];
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: sequencedSelect(
        [
          [{ id: 5, cycleId: 31, sprintId: 999, name: "Regression" }],
          [{ runId: 5, passed: 1, failed: 0, blocked: 0, skipped: 0, notRun: 0 }],
          [{ id: 31, legacySprintId: 7 }],
        ],
        calls,
      ),
    } as unknown as Db;
    const svc = new TestRunsService(db, makeAccess(), audit);

    const page = await svc.listRuns(makeU(), PROJECT_ID, {});

    expect(page.data[0]).toMatchObject({ cycleId: 31, sprintId: 7 });
  });

  it("reports a null sprintId for a run bound to no cycle, whatever the legacy column holds", async () => {
    const calls: SelectCall[] = [];
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: sequencedSelect(
        [
          [{ id: 6, cycleId: null, sprintId: 999, name: "Ad hoc" }],
          [{ runId: 6, passed: 0, failed: 0, blocked: 0, skipped: 0, notRun: 0 }],
        ],
        calls,
      ),
    } as unknown as Db;
    const svc = new TestRunsService(db, makeAccess(), audit);

    const page = await svc.listRuns(makeU(), PROJECT_ID, {});

    expect(page.data[0]).toMatchObject({ sprintId: null });
    expect(calls.filter((c) => c.table === cycles)).toHaveLength(0);
  });

  it("derives getRun's sprintId from the cycle the run is bound to", async () => {
    const calls: SelectCall[] = [];
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
        testRuns: {
          findFirst: jest.fn().mockResolvedValue({ id: 5, cycleId: 31, sprintId: 999, name: "Regression" }),
        },
      },
      select: sequencedSelect([[], [{ id: 31, legacySprintId: 7 }]], calls),
    } as unknown as Db;
    const svc = new TestRunsService(db, makeAccess(), audit);

    const run = await svc.getRun(makeU(), PROJECT_ID, 5);

    expect(run).toMatchObject({ cycleId: 31, sprintId: 7 });
  });
});
