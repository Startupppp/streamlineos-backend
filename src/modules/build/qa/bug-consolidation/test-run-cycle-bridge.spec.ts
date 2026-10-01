import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { TestRunsService } from "../test-runs.service";
import { cycles, testRuns } from "../../../../db/schema";
import { projectAccessRow, standingAccess } from "../../core/project-crud/__tests__/project-access-doubles";

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
  return standingAccess({ "build:manage": "all" }) as unknown as AccessService;
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
    select: sequencedSelect([[projectAccessRow()], ...selectResults], calls),
    transaction,
  } as unknown as Db;
  return { db, transaction, insertedValues, insertedTables };
}

function updateDb(cycleRows: unknown[], updated: unknown) {
  const setObjects: Record<string, unknown>[] = [];
  const db = {
    query: {
      testRuns: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 5, status: "in_progress", startedAt: new Date(), completedAt: null }),
      },
    },
    select: jest.fn()
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: async () => [projectAccessRow()] }) }),
      })
      .mockReturnValue({
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

describe("TestRunsService.createRun — cycleId binding", () => {
  it("accepts cycleId as canonical input", async () => {
    const calls: SelectCall[] = [];
    const { db, insertedValues, insertedTables } = createRunDb(
      [[{ id: 44 }]],
      calls,
      { id: 2, runNumber: 1, name: "Smoke", cycleId: 44 },
    );
    const svc = new TestRunsService(db, makeAccess(), audit);

    const run = await svc.createRun(makeU(), PROJECT_ID, { name: "Smoke", cycleId: 44 });

    expect(insertedValues[insertedTables.indexOf(testRuns)]!["cycleId"]).toBe(44);
    expect(run).toMatchObject({ cycleId: 44 });
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

  it("issues no cycle lookup and writes a null cycleId when no cycleId is supplied", async () => {
    const calls: SelectCall[] = [];
    const { db, insertedValues, insertedTables } = createRunDb([], calls, {
      id: 3,
      runNumber: 1,
      name: "Ad hoc",
      cycleId: null,
    });
    const svc = new TestRunsService(db, makeAccess(), audit);

    await svc.createRun(makeU(), PROJECT_ID, { name: "Ad hoc" });

    expect(calls.filter((c) => c.table === cycles)).toHaveLength(0);
    expect(insertedValues[insertedTables.indexOf(testRuns)]!["cycleId"]).toBeNull();
  });
});

describe("TestRunsService.updateRun — cycleId binding", () => {
  it("leaves the cycle binding untouched when neither cycleId is in the patch", async () => {
    const { db, setObjects } = updateDb([], { id: 5, cycleId: 31 });
    const svc = new TestRunsService(db, makeAccess(), audit);

    await svc.updateRun(makeU(), PROJECT_ID, 5, { name: "Renamed" });

    expect(Object.keys(setObjects[0]!)).not.toContain("cycleId");
    expect(Object.keys(setObjects[0]!)).not.toContain("sprintId");
  });
});

describe("TestRunsService — sprintId removal guard", () => {
  it("createRun insert payload contains cycleId and no sprintId key", async () => {
    const calls: SelectCall[] = [];
    const { db, insertedValues, insertedTables } = createRunDb(
      [[{ id: 55 }]],
      calls,
      { id: 1, runNumber: 1, name: "Regression", cycleId: 55 },
    );
    const svc = new TestRunsService(db, makeAccess(), audit);

    await svc.createRun(makeU(), PROJECT_ID, { name: "Regression", cycleId: 55 });

    const payload = insertedValues[insertedTables.indexOf(testRuns)]!;
    expect(payload).toBeDefined();
    expect(Object.keys(payload)).toContain("cycleId");
    expect(Object.keys(payload)).not.toContain("sprintId");
  });

  it("createRun response row carries no sprintId key", async () => {
    const calls: SelectCall[] = [];
    const { db } = createRunDb(
      [[{ id: 55 }]],
      calls,
      { id: 1, runNumber: 1, name: "Regression", cycleId: 55 },
    );
    const svc = new TestRunsService(db, makeAccess(), audit);

    const run = await svc.createRun(makeU(), PROJECT_ID, { name: "Regression", cycleId: 55 });

    expect(run).not.toHaveProperty("sprintId");
  });

  it("updateRun SET payload contains no sprintId key", async () => {
    const { db, setObjects } = updateDb([{ id: 55 }], { id: 5, cycleId: 55, name: "Regression" });
    const svc = new TestRunsService(db, makeAccess(), audit);

    await svc.updateRun(makeU(), PROJECT_ID, 5, { cycleId: 55 });

    expect(Object.keys(setObjects[0]!)).not.toContain("sprintId");
    expect(Object.keys(setObjects[0]!)).toContain("cycleId");
  });

  it("updateRun response row carries no sprintId key", async () => {
    const { db } = updateDb([{ id: 55 }], { id: 5, cycleId: 55, name: "Regression" });
    const svc = new TestRunsService(db, makeAccess(), audit);

    const row = await svc.updateRun(makeU(), PROJECT_ID, 5, { cycleId: 55 });

    expect(row).not.toHaveProperty("sprintId");
  });

  it("no cycle lookup is issued when no cycleId is supplied on create", async () => {
    const calls: SelectCall[] = [];
    const { db, insertedValues, insertedTables } = createRunDb([], calls, {
      id: 3,
      runNumber: 1,
      name: "Ad hoc",
      cycleId: null,
    });
    const svc = new TestRunsService(db, makeAccess(), audit);

    await svc.createRun(makeU(), PROJECT_ID, { name: "Ad hoc" });

    expect(calls.filter((c) => c.table === cycles)).toHaveLength(0);
    expect(insertedValues[insertedTables.indexOf(testRuns)]!["cycleId"]).toBeNull();
  });
});
