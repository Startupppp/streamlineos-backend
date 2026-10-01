process.env.APP_URL ??= "http://localhost:1000";

import { ProjectsTicketsCreateService } from "./projects-tickets-create.service";
import { createTicketSchema } from "../dto/ticket.schemas";
import * as actorSeam from "../../../../common/organization/organization-actor";
import * as projectAccessSeam from "../project-crud/project-assignable-members";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

jest.mock("../../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn(),
  resolveOrganizationActorsByUserIds: jest.fn(),
  organizationActorHttpError: jest.fn(),
}));

jest.mock("../project-crud/project-assignable-members", () => ({
  resolveProjectAssignableMemberships: jest.fn(),
}));

jest.mock("../project-crud/project-access", () => ({
  assertProjectVisibleForWrite: jest.fn().mockResolvedValue(undefined),
  resolveProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: null }),
  assertProjectVisible: jest.fn().mockResolvedValue(undefined),
  lockProjectTicketMutation: jest.fn().mockResolvedValue(undefined),
}));

const makeUser = (): CurrentUserContext => ({
  userId: "user-caller",
  orgId: "org-1",
  role: "EMPLOYEE",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
});

const CREATED_TICKET = {
  id: 100,
  orgId: "org-1",
  projectId: 1,
  ticketNumber: 1,
  title: "Test",
  type: "TASK",
  status: "TODO",
  priority: "MEDIUM",
  cycleId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeHarness(cycleBridgeRows: { id: number }[]) {
  const insertedValues: Record<string, unknown>[] = [];
  const insertChain = {
    values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
      insertedValues.push(v);
      return insertChain;
    }),
    returning: jest.fn().mockResolvedValue([CREATED_TICKET]),
  };
  const cycleSelectLimit = jest.fn().mockResolvedValue(cycleBridgeRows);
  const cycleSelectChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: cycleSelectLimit,
  };
  const db = {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue(null) },
      projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, deletedAt: null, key: "PRJ" }) },
    },
    select: jest.fn().mockReturnValue(cycleSelectChain),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        insert: jest.fn().mockReturnValue(insertChain),
        execute: jest.fn().mockResolvedValue([{ start: 1 }]),
      }),
    ),
  } as unknown as Db;

  const svc = new ProjectsTicketsCreateService(
    db,
    { create: jest.fn() } as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    { validateTicketStatus: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    { runForTicketEvent: jest.fn() } as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as never,
    { holds: jest.fn().mockResolvedValue(true) } as never,
  );

  const ticketInsert = () => insertedValues.find((v) => "ticketNumber" in v);
  return { svc, db, ticketInsert, cycleSelectLimit };
}

beforeEach(() => {
  jest.clearAllMocks();
  (actorSeam.resolveOrganizationActorsByUserIds as jest.Mock).mockResolvedValue(
    new Map([["user-caller", { membershipId: 5, userId: "user-caller" }]]),
  );
  (projectAccessSeam.resolveProjectAssignableMemberships as jest.Mock).mockResolvedValue(new Map());
});

describe("ProjectsTicketsCreateService.createTicket — cycleId is the only iteration binding", () => {
  it("writes the supplied cycleId straight onto the ticket, with no legacy resolution step in between", async () => {
    const { svc, ticketInsert } = makeHarness([{ id: 55 }]);
    await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", cycleId: 77 });
    expect(ticketInsert()).toMatchObject({ cycleId: 77 });
  });

  it("leaves cycleId unset and issues no cycle lookup when the request binds no iteration", async () => {
    const { svc, ticketInsert, cycleSelectLimit } = makeHarness([{ id: 55 }]);
    await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK" });
    expect(ticketInsert()!.cycleId).toBeUndefined();
    expect(cycleSelectLimit).not.toHaveBeenCalled();
  });

  it("never names sprintId on the insert, because tickets.sprint_id is the column phase-04 drops", async () => {
    const { svc, ticketInsert } = makeHarness([{ id: 55 }]);
    await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", cycleId: 77 });
    expect(ticketInsert()).toBeDefined();
    expect(Object.keys(ticketInsert()!)).not.toContain("sprintId");
  });

  it("returns a created ticket carrying no sprintId key at all, so a client cannot read a stale iteration identity off the response", async () => {
    const { svc } = makeHarness([{ id: 55 }]);
    const created = await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", cycleId: 77 });
    expect(created).not.toHaveProperty("sprintId");
    expect(created).toHaveProperty("cycleId");
  });

  it("looks the supplied cycle up before writing it, because fk_tickets_org_cycle enforces the organization and nothing else enforces the project", async () => {
    const { svc, cycleSelectLimit } = makeHarness([{ id: 77 }]);
    await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", cycleId: 77 });
    expect(cycleSelectLimit).toHaveBeenCalledTimes(1);
  });

  it("issues no cycle lookup when no cycleId is supplied, so the common create path pays nothing for the check", async () => {
    const { svc, cycleSelectLimit } = makeHarness([{ id: 77 }]);
    await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK" });
    expect(cycleSelectLimit).not.toHaveBeenCalled();
  });

  it("refuses a cycle that does not resolve inside the target project rather than binding a ticket across projects", async () => {
    const { svc } = makeHarness([]);
    await expect(
      svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", cycleId: 77 }),
    ).rejects.toThrow("Cycle not found in this project");
  });


  it("the createTicket request contract rejects a sprintId outright, because createTicketSchema is strict and no longer declares the field", () => {
    const parsed = createTicketSchema.safeParse({ title: "My ticket", type: "TASK", sprintId: 9 });
    expect(parsed.success).toBe(false);
    expect(createTicketSchema.safeParse({ title: "My ticket", type: "TASK", cycleId: 77 }).success).toBe(true);
  });
});
