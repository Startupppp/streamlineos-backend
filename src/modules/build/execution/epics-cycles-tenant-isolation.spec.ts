import type { Db } from "../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";
import { EpicsService } from "./epics.service";
import { CyclesService } from "./cycles.service";
import { epicRowSchema } from "./dto/execution-response.schemas";
import { BuildTicketCreationService } from "../core/tickets";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

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

function owner(orgId: string): CurrentUserContext {
  return {
    userId: "u1",
    orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

async function epicsService(db: Db, ticketCreation: object = {}): Promise<EpicsService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      EpicsService,
      { provide: DRIZZLE, useValue: db },
      { provide: BuildTicketCreationService, useValue: ticketCreation },
      { provide: AccessService, useValue: { resolveUserPermissions: jest.fn() } },
    ],
  }).compile();
  return moduleRef.get(EpicsService);
}

async function cyclesService(db: Db): Promise<CyclesService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      CyclesService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: { resolveUserPermissions: jest.fn() } },
    ],
  }).compile();
  return moduleRef.get(CyclesService);
}

describe("EpicsService — cross-tenant isolation", () => {
  it("listEpics refuses a project the requesting org does not own (404, not an empty 200)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = { query: { projects: { findFirst: projectFindFirst }, tickets: { findMany } } } as unknown as Db;
    const svc = await epicsService(db);

    await expect(svc.listEpics(owner(ATTACKER_ORG), 1)).rejects.toThrow(NotFoundException);

    expect(findMany).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listEpics returns epics for the owning org (control — same-tenant access works)", async () => {
    const fakeEpic = { id: 1, orgId: OWNER_ORG, title: "Epic 1", type: "EPIC" };
    const relWhere = jest.fn().mockResolvedValue([]);
    const relFrom = jest.fn().mockReturnValue({ where: relWhere });
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        tickets: { findMany: jest.fn().mockResolvedValue([fakeEpic]) },
      },
      select: jest.fn().mockReturnValue({ from: relFrom }),
    } as unknown as Db;
    const svc = await epicsService(db);

    const page = await svc.listEpics(owner(OWNER_ORG), 1);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toHaveProperty("dependencyCount", 0);
    expect(page.pagination).toEqual({ limit: 100, hasMore: false, nextCursor: null });
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
    const svc = await epicsService(db);

    await expect(svc.createEpic(owner(ATTACKER_ORG), 1, { title: "Epic" })).rejects.toThrow(NotFoundException);

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
    const svc = await epicsService(db);

    await expect(svc.createEpic(owner(OWNER_ORG), 999, { title: "Epic" })).rejects.toThrow(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
  });

  it("creates the epic when the project belongs to the caller's org (own project)", async () => {
    const fakeEpic = { id: 1, orgId: OWNER_ORG, title: "Epic", type: "EPIC" };
    const ticketCreation = {
      create: jest.fn().mockResolvedValue({ tickets: [fakeEpic], command: {} }),
      createInTransaction: jest.fn(),
      publish: jest.fn(),
    };
    const projectFindFirst = jest.fn().mockResolvedValue({ id: 1 });
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
    } as unknown as Db;
    const svc = await epicsService(db, ticketCreation);

    const result = await svc.createEpic(owner(OWNER_ORG), 1, { title: "Epic" });

    expect(result).toEqual(fakeEpic);
    expect(ticketCreation.create).toHaveBeenCalledTimes(1);
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
    const svc = await cyclesService(db);

    await expect(
      svc.createCycle(owner(ATTACKER_ORG), 1, { name: "Cycle A", startDate: "2024-01-01", endDate: "2024-01-31" }),
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
    const svc = await cyclesService(db);

    const result = await svc.createCycle(owner(OWNER_ORG), 1, { name: "Cycle A", startDate: "2024-01-01", endDate: "2024-01-31" });
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
    const svc = await cyclesService(db);

    await expect(svc.listCycles(owner(ATTACKER_ORG), 1, {})).rejects.toThrow(NotFoundException);

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
    const svc = await cyclesService(db);

    const result = await svc.listCycles(owner(OWNER_ORG), 1, {});
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.orgId).toBe(OWNER_ORG);
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
    health: null,
    projectId: 1,
    ticketNumber: 42,
    cycleId: null,
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
    dependencyCount: 0,
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
    const cycleFindFirst = jest.fn().mockResolvedValue({ version: 1 });
    const select = jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) });
    const where = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 99, version: 2 }]) });
    const db = {
      query: { projects: { findFirst: projectFindFirst }, cycles: { findFirst: cycleFindFirst } },
      select,
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = await cyclesService(db);

    await svc.updateCycle(owner(OWNER_ORG), 7, 99, { version: 1, name: "Renamed" });

    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(7);
  });

  it("updateCycle refuses a project the caller's org does not own, rather than trusting the cycle id alone", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      update: jest.fn(),
    } as unknown as Db;
    const svc = await cyclesService(db);

    await expect(svc.updateCycle(owner(ATTACKER_ORG), 7, 99, { name: "Renamed", version: 1 })).rejects.toThrow(NotFoundException);
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
    const svc = await cyclesService(db);

    await svc.deleteCycle(owner(OWNER_ORG), 7, 99);

    expect(sqlValues(deleteWhere.mock.calls[0]?.[0])).toContain(7);
  });

  it("deleteCycle refuses a project the caller's org does not own before opening a transaction", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      transaction: jest.fn(),
    } as unknown as Db;
    const svc = await cyclesService(db);

    await expect(svc.deleteCycle(owner(ATTACKER_ORG), 7, 99)).rejects.toThrow(NotFoundException);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
