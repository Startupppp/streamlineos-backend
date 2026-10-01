import { ForbiddenException, GoneException, NotFoundException } from "@nestjs/common";
import { Column, SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import {
  cycles,
  intakeItems,
  modules,
  outboxEvents,
  projectMilestones,
  projectViews,
  tickets,
} from "../../../db/schema";
import { SprintsService } from "./sprints.service";
import { ModulesService } from "./modules.service";
import { IntakeService, MilestonesService, ViewsService } from "./workspace.service";
import { BuildTicketCreationService } from "../core/tickets";
import { lifecycleAuditDouble } from "../lifecycle/audit-double";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeIntakeTicketCreation() {
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

jest.mock("../core/project-crud/project-access", () => ({
  ...jest.requireActual("../core/project-crud/project-access"),
  assertProjectVisible: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../core/lib/allocate-ticket-number", () => ({
  allocateTicketNumbers: jest.fn(async () => 1),
}));
jest.mock("../core/lib/build-ticket-capacity", () => ({
  reserveTicketCapacity: jest.fn(async () => undefined),
}));

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-7";
const OTHER_USER = "user-9";

function milestoneActor(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, false),
  };
}
const PROJECT_A = 11;
const PROJECT_B = 22;
const SPRINT_A = 100;
const SPRINT_B = 101;
const MODULE_A = 200;
const MODULE_B = 201;
const TICKET_A = 300;
const TICKET_B = 301;
const MILESTONE_A = 400;
const MILESTONE_B = 401;
const INTAKE_A = 500;
const INTAKE_B = 501;
const CYCLE_A = 150;
const CYCLE_B = 151;
const VIEW_A = 600;
const VIEW_B = 601;
const VIEW_A_OTHERS_PRIVATE = 602;
const VIEW_WORKSPACE = 603;

type Row = Record<string, unknown>;

interface Predicate {
  key: string;
  op: "eq" | "isNull";
  value?: unknown;
}

function columnKey(column: Column): string {
  const table = column.table as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(table)) {
    if (value === column) return key;
  }
  return column.name;
}

function chunkText(chunk: unknown): string {
  const value = (chunk as { value?: unknown } | undefined)?.value;
  return Array.isArray(value) ? value.join("").trim() : "";
}

function collect(node: unknown, out: Predicate[]): Predicate[] {
  if (!(node instanceof SQL)) return out;
  const chunks = node.queryChunks as unknown[];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk instanceof SQL) {
      collect(chunk, out);
      continue;
    }
    if (!(chunk instanceof Column)) continue;
    const operator = chunkText(chunks[index + 1]);
    if (operator === "=") {
      const param = chunks[index + 2] as { value?: unknown };
      out.push({ key: columnKey(chunk), op: "eq", value: param?.value });
    } else if (operator === "is null") {
      out.push({ key: columnKey(chunk), op: "isNull" });
    }
  }
  return out;
}

function matches(where: unknown, row: Row): boolean {
  const predicates = collect(where, []);
  expect(predicates.length).toBeGreaterThan(0);
  return predicates.every((predicate) =>
    predicate.op === "isNull"
      ? row[predicate.key] === null || row[predicate.key] === undefined
      : row[predicate.key] === predicate.value,
  );
}

interface Store {
  cycles: Row[];
  modules: Row[];
  tickets: Row[];
  milestones: Row[];
  intake: Row[];
  views: Row[];
}

function tableRows(store: Store, table: unknown): Row[] | null {
  if (table === cycles) return store.cycles;
  if (table === modules) return store.modules;
  if (table === tickets) return store.tickets;
  if (table === projectMilestones) return store.milestones;
  if (table === intakeItems) return store.intake;
  if (table === projectViews) return store.views;
  return null;
}

function makeStore(): Store {
  return {
    cycles: [
      { id: CYCLE_A, orgId: ORG, projectId: PROJECT_A, name: "cycle-a", status: "active" },
      { id: CYCLE_B, orgId: ORG, projectId: PROJECT_B, name: "cycle-b", status: "active" },
    ],
    modules: [
      { id: MODULE_A, orgId: ORG, projectId: PROJECT_A, name: "module-a", status: "backlog", version: 1 },
      { id: MODULE_B, orgId: ORG, projectId: PROJECT_B, name: "module-b", status: "backlog", version: 1 },
    ],
    tickets: [
      { id: TICKET_A, orgId: ORG, projectId: PROJECT_A, moduleId: MODULE_A, deletedAt: null },
      { id: TICKET_B, orgId: ORG, projectId: PROJECT_B, moduleId: MODULE_B, deletedAt: null },
    ],
    milestones: [
      { id: MILESTONE_A, orgId: ORG, projectId: PROJECT_A, name: "milestone-a", status: "PENDING", deletedAt: null, version: 1 },
      { id: MILESTONE_B, orgId: ORG, projectId: PROJECT_B, name: "milestone-b", status: "PENDING", deletedAt: null, version: 1 },
    ],
    intake: [
      { id: INTAKE_A, orgId: ORG, projectId: PROJECT_A, title: "intake-a", description: "a", status: "pending", declineReason: null, linkedWorkItemId: null },
      { id: INTAKE_B, orgId: ORG, projectId: PROJECT_B, title: "intake-b", description: "b", status: "pending", declineReason: null, linkedWorkItemId: null },
    ],
    views: [
      { id: VIEW_A, orgId: ORG, projectId: PROJECT_A, createdBy: USER, visibility: "shared", scope: "project", name: "view-a" },
      { id: VIEW_B, orgId: ORG, projectId: PROJECT_B, createdBy: USER, visibility: "shared", scope: "project", name: "view-b" },
      { id: VIEW_A_OTHERS_PRIVATE, orgId: ORG, projectId: PROJECT_A, createdBy: OTHER_USER, visibility: "private", scope: "project", name: "view-private" },
      { id: VIEW_WORKSPACE, orgId: ORG, projectId: null, createdBy: USER, visibility: "shared", scope: "workspace", name: "view-workspace" },
    ],
  };
}

interface Fixture {
  db: Db;
  store: Store;
  outbox: Row[];
  inserted: Row[];
  transaction: jest.Mock;
}

function makeDb(store: Store): Fixture {
  const outbox: Row[] = [];
  const inserted: Row[] = [];

  const findFirst = (rows: () => Row[]) =>
    jest.fn(async (args: { where?: unknown }) => {
      const hit = rows().find((row) => matches(args.where, row));
      return hit ? { ...hit } : undefined;
    });

  const selectBuilder = () => ({
    from: (table: unknown) => ({
      leftJoin: () => ({ where: () => ({ groupBy: async () => [] }) }),
      where: (where: unknown) => {
        const rows = tableRows(store, table);
        if (!rows) throw new Error("unexpected select target");
        const hit = rows.filter((row) => matches(where, row)).map((row) => ({ ...row }));
        return { limit: async () => hit };
      },
    }),
  });

  const updateBuilder = (table: unknown) => ({
    set: (values: Row) => ({
      where: (where: unknown) => {
        const rows = tableRows(store, table);
        if (!rows) throw new Error("unexpected update target");
        const hit = rows.filter((row) => matches(where, row));
        for (const row of hit) Object.assign(row, values);
        return { returning: async () => hit.map((row) => ({ ...row })) };
      },
    }),
  });

  const insertBuilder = (table: unknown) => ({
    values: (values: Row) => {
      if (table === outboxEvents) outbox.push(values);
      else inserted.push({ table, ...values });
      if (table === tickets) {
        const row = { id: 9001, ...values };
        store.tickets.push(row);
        return { returning: async () => [row], onConflictDoNothing: async () => undefined };
      }
      return { returning: async () => [values], onConflictDoNothing: async () => undefined };
    },
  });

  const deleteBuilder = (table: unknown) => ({
    where: (where: unknown) => {
      const rows = tableRows(store, table);
      if (!rows) throw new Error("unexpected delete target");
      const removed = rows.filter((row) => matches(where, row));
      const kept = rows.filter((row) => !removed.includes(row));
      rows.length = 0;
      rows.push(...kept);
      return { returning: async () => removed.map((row) => ({ ...row })) };
    },
  });

  const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ update: updateBuilder, insert: insertBuilder, delete: deleteBuilder, select: selectBuilder }),
  );

  const db = {
    query: {
      tickets: {
        findMany: jest.fn(async (args: { where?: unknown }) =>
          store.tickets.filter((row) => matches(args.where, row)).map((row) => ({ ...row })),
        ),
      },
      projectViews: { findFirst: findFirst(() => store.views) },
      modules: { findFirst: findFirst(() => store.modules) },
      projectMilestones: { findFirst: findFirst(() => store.milestones) },
    },
    select: jest.fn(selectBuilder),
    update: updateBuilder,
    insert: insertBuilder,
    delete: deleteBuilder,
    transaction,
  } as unknown as Db;

  return { db, store, outbox, inserted, transaction };
}

describe("SprintsService — the frozen surface cannot bind to any project, in or out of tenant", () => {
  const CASES: Array<[string, (svc: SprintsService) => Promise<unknown>]> = [
    ["getSprint, in-project", (svc) => svc.getSprint(ORG, PROJECT_A, SPRINT_A)],
    ["getSprint, sibling project", (svc) => svc.getSprint(ORG, PROJECT_A, SPRINT_B)],
    ["getSprint, foreign tenant", (svc) => svc.getSprint(OTHER_ORG, PROJECT_A, SPRINT_A)],
    ["updateSprint, in-project", (svc) => svc.updateSprint(ORG, PROJECT_A, SPRINT_A, { name: "sprint-a-v2" }, USER)],
    ["updateSprint, sibling project", (svc) => svc.updateSprint(ORG, PROJECT_A, SPRINT_B, { name: "hijacked" }, USER)],
    ["deleteSprint, sibling project", (svc) => svc.deleteSprint(ORG, PROJECT_A, SPRINT_B)],
    ["listSprints, in-project", (svc) => svc.listSprints(ORG, PROJECT_A)],
  ];

  it.each(CASES)("%s is refused with GoneException, which is a stronger binding guarantee than the 404 it replaced", async (_name, call) => {
    const { db } = makeDb(makeStore());

    await expect(call(new SprintsService(db, null))).rejects.toThrow(GoneException);
  });

  it.each(CASES)("%s opens no transaction, so the frozen surface cannot reach a database that no longer has build.sprints", async (_name, call) => {
    const store = makeStore();
    const { db, transaction } = makeDb(store);

    await expect(call(new SprintsService(db, null))).rejects.toThrow(GoneException);

    expect(transaction).not.toHaveBeenCalled();
  });

  it("no sprint status change can emit build.sprint.completed any more, because the only producer of that event is frozen", async () => {
    const { db, outbox } = makeDb(makeStore());

    await expect(
      new SprintsService(db, null).updateSprint(ORG, PROJECT_A, SPRINT_A, { status: "COMPLETED" }, USER),
    ).rejects.toThrow(GoneException);

    expect(outbox).toHaveLength(0);
  });
});

describe("ModulesService — a module addressed through /build/:projectId must belong to that project", () => {
  it("updateModule leaves a same-org module owned by another project untouched and answers 404", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new ModulesService(db).updateModule(ORG, PROJECT_A, MODULE_B, { name: "hijacked", version: 1 }),
    ).rejects.toThrow(NotFoundException);
    expect(store.modules.find((row) => row.id === MODULE_B)?.name).toBe("module-b");
  });

  it("updateModule updates the module that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new ModulesService(db).updateModule(ORG, PROJECT_A, MODULE_A, { name: "module-a-v2", version: 1 }),
    ).resolves.toMatchObject({ id: MODULE_A, name: "module-a-v2" });
  });

  it("updateModule still answers 404 for another tenant's module id", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new ModulesService(db).updateModule(OTHER_ORG, PROJECT_A, MODULE_A, { name: "hijacked", version: 1 }),
    ).rejects.toThrow(NotFoundException);
    expect(store.modules.find((row) => row.id === MODULE_A)?.name).toBe("module-a");
  });

  it("deleteModule does not delete a same-org module owned by another project", async () => {
    const store = makeStore();
    const { db, transaction } = makeDb(store);

    await expect(new ModulesService(db).deleteModule(ORG, PROJECT_A, MODULE_B)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.modules.some((row) => row.id === MODULE_B)).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("deleteModule does not even stage a moduleId clear on another project's tickets", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(new ModulesService(db).deleteModule(ORG, PROJECT_A, MODULE_B)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.tickets.find((row) => row.id === TICKET_B)?.moduleId).toBe(MODULE_B);
  });

  it("deleteModule deletes the module that belongs to the URL project and clears its tickets (control)", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(new ModulesService(db).deleteModule(ORG, PROJECT_A, MODULE_A)).resolves.toEqual({
      success: true,
    });
    expect(store.modules.some((row) => row.id === MODULE_A)).toBe(false);
    expect(store.tickets.find((row) => row.id === TICKET_A)?.moduleId).toBeNull();
  });
});

describe("MilestonesService — a milestone addressed through /build/:projectId must belong to that project", () => {
  it("updateMilestone leaves a same-org milestone owned by another project untouched and answers 404", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new MilestonesService(db, {} as never, lifecycleAuditDouble()).updateMilestone(milestoneActor(ORG), PROJECT_A, MILESTONE_B, { name: "hijacked", version: 1 }),
    ).rejects.toThrow(NotFoundException);
    expect(store.milestones.find((row) => row.id === MILESTONE_B)?.name).toBe("milestone-b");
  });

  it("updateMilestone updates the milestone that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new MilestonesService(db, {} as never, lifecycleAuditDouble()).updateMilestone(milestoneActor(ORG), PROJECT_A, MILESTONE_A, { name: "milestone-a-v2", version: 1 }),
    ).resolves.toMatchObject({ id: MILESTONE_A, name: "milestone-a-v2" });
  });

  it("updateMilestone answers 404 rather than 403 for another tenant's milestone id", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new MilestonesService(db, {} as never, lifecycleAuditDouble()).updateMilestone(milestoneActor(OTHER_ORG), PROJECT_A, MILESTONE_A, { name: "hijacked", version: 1 }),
    ).rejects.toThrow(NotFoundException);
    expect(store.milestones.find((row) => row.id === MILESTONE_A)?.name).toBe("milestone-a");
  });

  it("deleteMilestone does not soft-delete a same-org milestone owned by another project", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new MilestonesService(db, {} as never, lifecycleAuditDouble()).deleteMilestone(milestoneActor(ORG), PROJECT_A, MILESTONE_B),
    ).rejects.toThrow(NotFoundException);
    expect(store.milestones.find((row) => row.id === MILESTONE_B)?.deletedAt).toBeNull();
  });

  it("deleteMilestone soft-deletes the milestone that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new MilestonesService(db, {} as never, lifecycleAuditDouble()).deleteMilestone(milestoneActor(ORG), PROJECT_A, MILESTONE_A),
    ).resolves.toEqual({ success: true });
    expect(store.milestones.find((row) => row.id === MILESTONE_A)?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("IntakeService — an intake request addressed through /build/:projectId must belong to that project", () => {
  it("updateIntake declines nothing when the request belongs to another project of the same org", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new IntakeService(db, makeIntakeTicketCreation()).updateIntake(ORG, USER, PROJECT_A, INTAKE_B, {
        status: "declined",
        declineReason: "not mine",
      }),
    ).rejects.toThrow(NotFoundException);
    expect(store.intake.find((row) => row.id === INTAKE_B)?.status).toBe("pending");
  });

  it("updateIntake declines the request that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new IntakeService(db, makeIntakeTicketCreation()).updateIntake(ORG, USER, PROJECT_A, INTAKE_A, {
        status: "declined",
        declineReason: "duplicate of ABC",
      }),
    ).resolves.toMatchObject({ id: INTAKE_A, status: "declined" });
  });

  it("updateIntake creates no ticket when accepting a request that belongs to another project", async () => {
    const store = makeStore();
    const { db, transaction } = makeDb(store);

    await expect(
      new IntakeService(db, makeIntakeTicketCreation()).updateIntake(ORG, USER, PROJECT_A, INTAKE_B, { status: "accepted" }),
    ).rejects.toThrow(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
    expect(store.tickets).toHaveLength(2);
    expect(store.intake.find((row) => row.id === INTAKE_B)?.status).toBe("pending");
  });

  it("updateIntake accepts an in-project request and opens one transaction that creates its ticket (control)", async () => {
    const store = makeStore();
    const { db, transaction } = makeDb(store);

    await expect(
      new IntakeService(db, makeIntakeTicketCreation()).updateIntake(ORG, USER, PROJECT_A, INTAKE_A, { status: "accepted" }),
    ).resolves.toMatchObject({ id: INTAKE_A, status: "accepted" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(store.tickets).toHaveLength(3);
    expect(store.tickets.at(-1)).toMatchObject({ orgId: ORG, projectId: PROJECT_A, title: "intake-a" });
  });

  it("updateIntake answers 404 rather than 403 for another tenant's request id", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new IntakeService(db, makeIntakeTicketCreation()).updateIntake(OTHER_ORG, USER, PROJECT_A, INTAKE_A, {
        status: "declined",
        declineReason: "x",
      }),
    ).rejects.toThrow(NotFoundException);
    expect(store.intake.find((row) => row.id === INTAKE_A)?.status).toBe("pending");
  });
});

describe("ViewsService — a view addressed through /build/:projectId must belong to that project", () => {
  it("updateView leaves a same-org view owned by another project untouched and answers 404", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new ViewsService(db).updateView(ORG, USER, PROJECT_A, VIEW_B, { name: "hijacked" }),
    ).rejects.toThrow(NotFoundException);
    expect(store.views.find((row) => row.id === VIEW_B)?.name).toBe("view-b");
  });

  it("updateView updates the view that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new ViewsService(db).updateView(ORG, USER, PROJECT_A, VIEW_A, { name: "view-a-v2" }),
    ).resolves.toMatchObject({ id: VIEW_A, name: "view-a-v2" });
  });

  it("updateView keeps answering 403 for an in-project private view owned by another actor, so the project binding did not swallow the ownership rule", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new ViewsService(db).updateView(ORG, USER, PROJECT_A, VIEW_A_OTHERS_PRIVATE, { name: "hijacked" }),
    ).rejects.toThrow(ForbiddenException);
    expect(store.views.find((row) => row.id === VIEW_A_OTHERS_PRIVATE)?.name).toBe("view-private");
  });

  it("updateView refuses a workspace-scoped view addressed through a project route, because it has no project", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new ViewsService(db).updateView(ORG, USER, PROJECT_A, VIEW_WORKSPACE, { name: "hijacked" }),
    ).rejects.toThrow(NotFoundException);
    expect(store.views.find((row) => row.id === VIEW_WORKSPACE)?.name).toBe("view-workspace");
  });

  it("updateWorkspaceView still updates that same workspace view through its own route (control)", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new ViewsService(db).updateWorkspaceView(ORG, USER, VIEW_WORKSPACE, { name: "view-workspace-v2" }),
    ).resolves.toMatchObject({ id: VIEW_WORKSPACE, name: "view-workspace-v2" });
  });

  it("deleteView does not delete a same-org view owned by another project", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(new ViewsService(db).deleteView(ORG, USER, PROJECT_A, VIEW_B)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.views.some((row) => row.id === VIEW_B)).toBe(true);
  });

  it("deleteView deletes the view that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(new ViewsService(db).deleteView(ORG, USER, PROJECT_A, VIEW_A)).resolves.toEqual({
      success: true,
    });
    expect(store.views.some((row) => row.id === VIEW_A)).toBe(false);
  });

  it("deleteView keeps answering 403 for an in-project private view owned by another actor", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(
      new ViewsService(db).deleteView(ORG, USER, PROJECT_A, VIEW_A_OTHERS_PRIVATE),
    ).rejects.toThrow(ForbiddenException);
    expect(store.views.some((row) => row.id === VIEW_A_OTHERS_PRIVATE)).toBe(true);
  });

  it("deleteView answers 404 rather than 403 for another tenant's view id", async () => {
    const store = makeStore();
    const { db } = makeDb(store);

    await expect(new ViewsService(db).deleteView(OTHER_ORG, USER, PROJECT_A, VIEW_A)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.views.some((row) => row.id === VIEW_A)).toBe(true);
  });
});
