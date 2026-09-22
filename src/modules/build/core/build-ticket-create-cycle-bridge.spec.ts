process.env.APP_URL ??= "http://localhost:1000";

import { BadRequestException } from "@nestjs/common";
import { ProjectsTicketsCreateService } from "./projects-tickets-create.service";
import * as actorSeam from "../../../common/organization/organization-actor";
import * as projectAccessSeam from "./project-access";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

jest.mock("../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn(),
  resolveOrganizationActorsByUserIds: jest.fn(),
  organizationActorHttpError: jest.fn(),
}));

jest.mock("./project-access", () => ({
  resolveProjectAssignableMemberships: jest.fn(),
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
    { checkProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" }) } as never,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    { runForTicketEvent: jest.fn() } as never,
    { del: jest.fn().mockResolvedValue(undefined) } as never,
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

describe("ProjectsTicketsCreateService.createTicket — sprint-to-cycle write bridge", () => {
  it("never writes tickets.sprint_id, the column phase-04 drops, even when the request supplies sprintId", async () => {
    const { svc, ticketInsert } = makeHarness([{ id: 55 }]);
    await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", sprintId: 9 });
    expect(ticketInsert()).toBeDefined();
    expect(Object.keys(ticketInsert()!)).not.toContain("sprintId");
  });

  it("resolves a supplied sprintId to its cycle through cycles.legacySprintId and writes that cycleId", async () => {
    const { svc, ticketInsert } = makeHarness([{ id: 55 }]);
    await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", sprintId: 9 });
    expect(ticketInsert()).toMatchObject({ cycleId: 55 });
  });

  it("rejects an unmappable sprintId with BadRequestException instead of silently dropping the iteration binding", async () => {
    const { svc } = makeHarness([]);
    await expect(
      svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", sprintId: 404 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("does not create the ticket at all when the sprintId is unmappable", async () => {
    const { svc, db } = makeHarness([]);
    await expect(
      svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", sprintId: 404 }),
    ).rejects.toThrow(BadRequestException);
    expect((db as unknown as { transaction: jest.Mock }).transaction).not.toHaveBeenCalled();
  });

  it("lets an explicit cycleId win over a legacy sprintId, matching the precedence the update path already applies", async () => {
    const { svc, ticketInsert } = makeHarness([{ id: 55 }]);
    await svc.createTicket(makeUser(), 1, {
      title: "My ticket",
      type: "TASK",
      sprintId: 9,
      cycleId: 77,
    });
    expect(ticketInsert()).toMatchObject({ cycleId: 77 });
  });

  it("keeps the wire contract: the created ticket still echoes the sprintId the caller sent, now derived from the bridged cycle", async () => {
    const { svc } = makeHarness([{ id: 55 }]);
    const created = await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", sprintId: 9 });
    expect(created.sprintId).toBe(9);
  });

  it("keeps the wire contract: a cycleId-only create echoes that cycle's legacySprintId", async () => {
    const { svc } = makeHarness([{ legacySprintId: 9 } as unknown as { id: number }]);
    const created = await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK", cycleId: 77 });
    expect(created.sprintId).toBe(9);
  });

  it("keeps the wire contract: an iteration-less create emits sprintId null rather than omitting the field", async () => {
    const { svc } = makeHarness([]);
    const created = await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK" });
    expect(created.sprintId).toBeNull();
  });

  it("leaves cycleId unset when neither sprintId nor cycleId is supplied", async () => {
    const { svc, ticketInsert, cycleSelectLimit } = makeHarness([{ id: 55 }]);
    await svc.createTicket(makeUser(), 1, { title: "My ticket", type: "TASK" });
    expect(ticketInsert()!.cycleId).toBeUndefined();
    expect(cycleSelectLimit).not.toHaveBeenCalled();
  });
});
