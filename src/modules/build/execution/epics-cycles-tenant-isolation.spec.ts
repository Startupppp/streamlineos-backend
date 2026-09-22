import type { Db } from "../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";
import { EpicsService } from "./epics.service";
import { CyclesService } from "./cycles.service";
import { epicRowSchema } from "./dto/execution-response.schemas";

type TxHandle = { insert: jest.Mock; execute: jest.Mock };

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

describe("EpicsService — cross-tenant isolation", () => {
  it("listEpics refuses a project the requesting org does not own (404, not an empty 200)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = { query: { projects: { findFirst: projectFindFirst }, tickets: { findMany } } } as unknown as Db;
    const svc = new EpicsService(db);

    await expect(svc.listEpics(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);

    expect(findMany).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listEpics returns epics for the owning org (control — same-tenant access works)", async () => {
    const fakeEpic = { id: 1, orgId: OWNER_ORG, title: "Epic 1", type: "EPIC" };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        tickets: { findMany: jest.fn().mockResolvedValue([fakeEpic]) },
      },
    } as unknown as Db;
    const svc = new EpicsService(db);

    const result = await svc.listEpics(OWNER_ORG, 1);
    expect(result).toHaveLength(1);
  });
});

describe("EpicsService — cross-tenant isolation — createEpic", () => {
  it("throws 404 when project belongs to a different org (cross-tenant)", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const transaction = jest.fn();
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      transaction,
    } as unknown as Db;
    const svc = new EpicsService(db);

    await expect(svc.createEpic(ATTACKER_ORG, "u1", 1, { title: "Epic" })).rejects.toThrow(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("throws 404 when project does not exist (unknown id)", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const transaction = jest.fn();
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      transaction,
    } as unknown as Db;
    const svc = new EpicsService(db);

    await expect(svc.createEpic(OWNER_ORG, "u1", 999, { title: "Epic" })).rejects.toThrow(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
  });

  it("creates the epic when the project belongs to the caller's org (own project)", async () => {
    const fakeEpic = { id: 1, orgId: OWNER_ORG, title: "Epic", type: "EPIC" };
    const returning = jest.fn().mockResolvedValue([fakeEpic]);
    const values = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn().mockReturnValue({ values });
    const execute = jest.fn().mockResolvedValue([{ start: 1 }]);
    const tx: TxHandle = { insert, execute };
    const projectFindFirst = jest.fn().mockResolvedValue({ id: 1 });
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      transaction: jest.fn().mockImplementation((cb: (handle: TxHandle) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;
    const svc = new EpicsService(db);

    const result = await svc.createEpic(OWNER_ORG, "u1", 1, { title: "Epic" });

    expect(result).toEqual(fakeEpic);
    expect(insert).toHaveBeenCalled();
  });
});

describe("CyclesService — cross-tenant isolation — createCycle", () => {
  it("createCycle throws 404 before any DB write when project belongs to a different org (assertProjectInOrg missing guard)", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const selectChain = { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) };
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      select: jest.fn().mockReturnValue(selectChain),
    } as unknown as Db;
    const svc = new CyclesService(db);

    await expect(
      svc.createCycle(ATTACKER_ORG, "u1", 1, { name: "Cycle A", startDate: "2024-01-01", endDate: "2024-01-31" }),
    ).rejects.toThrow(NotFoundException);

    expect(projectFindFirst).toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("createCycle succeeds when project belongs to the caller's org (control — own project passes)", async () => {
    const fakeCycle = { id: 5, orgId: OWNER_ORG, projectId: 1, name: "Cycle A", status: "draft" };
    const projectFindFirst = jest.fn().mockResolvedValue({ id: 1 });
    const returning = jest.fn().mockResolvedValue([fakeCycle]);
    const values = jest.fn().mockReturnValue({ returning });
    const selectChain = { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) };
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      select: jest.fn().mockReturnValue(selectChain),
      insert: jest.fn().mockReturnValue({ values }),
    } as unknown as Db;
    const svc = new CyclesService(db);

    const result = await svc.createCycle(OWNER_ORG, "u1", 1, { name: "Cycle A", startDate: "2024-01-01", endDate: "2024-01-31" });
    expect(result).toEqual(fakeCycle);
    expect(projectFindFirst).toHaveBeenCalled();
  });
});

describe("CyclesService — cross-tenant isolation", () => {
  it("listCycles refuses a project the requesting org does not own (404, not an empty 200)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new CyclesService(db);

    await expect(svc.listCycles(ATTACKER_ORG, 1, {})).rejects.toThrow(NotFoundException);

    expect(where).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listCycles returns cycles for the owning org (control — same-tenant access works)", async () => {
    const fakeCycle = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Sprint 1", status: "ACTIVE" };
    let call = 0;
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeCycle]) }) }) }) };
        }
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }) };
      }),
    } as unknown as Db;
    const svc = new CyclesService(db);

    const result = await svc.listCycles(OWNER_ORG, 1, {});
    expect(result).toHaveLength(1);
  });
});

describe("epicRowSchema — response contract completeness", () => {
  const baseEpicRow = {
    id: 1,
    orgId: "org1",
    title: "Big epic",
    description: null,
    type: "EPIC",
    status: "TODO",
    priority: "MEDIUM",
    projectId: 1,
    ticketNumber: 42,
    sprintId: null,
    epicId: null,
    assigneeMembershipId: null,
    points: null,
    storyPoints: null,
    startDate: null,
    dueDate: null,
    estimate: null,
    completionPercentage: 0,
    rank: "0|hzzzzz:",
    timeSpent: "0",
    version: 1,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("epicRowSchema preserves assignee when present — listEpics result must not strip the assignee field", () => {
    const itemWithAssignee = {
      ...baseEpicRow,
      assignee: { user: { id: "u1", name: "Alice", firstName: "Alice", lastName: "Smith", image: null, email: "alice@example.com" } },
    };

    const parsed = epicRowSchema.parse(itemWithAssignee);
    expect((parsed as Record<string, unknown>).assignee).toBeDefined();
  });
});

describe("CyclesService — cross-project scope within one org — updateCycle", () => {
  it("updateCycle constrains the UPDATE by projectId, so a cycle of a sibling project cannot be edited through this project's URL", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue({ id: 7 });
    const where = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 99 }]) });
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new CyclesService(db);

    await svc.updateCycle(OWNER_ORG, 7, 99, { name: "Renamed" });

    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(7);
  });

  it("updateCycle refuses a project the caller's org does not own, rather than trusting the cycle id alone", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      update: jest.fn(),
    } as unknown as Db;
    const svc = new CyclesService(db);

    await expect(svc.updateCycle(ATTACKER_ORG, 7, 99, { name: "Renamed" })).rejects.toThrow(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("CyclesService — cross-project scope within one org — deleteCycle", () => {
  it("deleteCycle constrains the DELETE by projectId, so deleting through a sibling project's URL cannot detach that project's tickets", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue({ id: 7 });
    const deleteWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 99 }]) });
    const tx = {
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }),
      delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    };
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      transaction: jest.fn(async (cb: (handle: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;
    const svc = new CyclesService(db);

    await svc.deleteCycle(OWNER_ORG, 7, 99);

    expect(sqlValues(deleteWhere.mock.calls[0]?.[0])).toContain(7);
  });

  it("deleteCycle refuses a project the caller's org does not own before opening a transaction", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      transaction: jest.fn(),
    } as unknown as Db;
    const svc = new CyclesService(db);

    await expect(svc.deleteCycle(ATTACKER_ORG, 7, 99)).rejects.toThrow(NotFoundException);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
