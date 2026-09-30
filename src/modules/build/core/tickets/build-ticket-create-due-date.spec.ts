process.env.APP_URL ??= "http://localhost:1000";

import { ProjectsTicketsCreateService } from "./projects-tickets-create.service";
import * as actorSeam from "../../../../common/organization/organization-actor";
import * as projectAccessSeam from "../project-crud/project-access";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

jest.mock("../../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn(),
  resolveOrganizationActorsByUserIds: jest.fn(),
  organizationActorHttpError: jest.fn(),
}));

jest.mock("../project-crud/project-access", () => ({
  resolveProjectAssignableMemberships: jest.fn(),
  resolveProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: null }),
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
  dueDate: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeHarness() {
  const insertedValues: Record<string, unknown>[] = [];
  const insertChain = {
    values: jest.fn().mockImplementation(
      (v: Record<string, unknown> | Record<string, unknown>[]) => {
        if (Array.isArray(v)) insertedValues.push(...v);
        else insertedValues.push(v);
        return insertChain;
      },
    ),
    returning: jest.fn().mockResolvedValue([CREATED_TICKET]),
  };
  const selectChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  const db = {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue(null) },
      projects: {
        findFirst: jest.fn().mockResolvedValue({ id: 1, deletedAt: null, key: "PRJ" }),
      },
    },
    select: jest.fn().mockReturnValue(selectChain),
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
    {
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    } as never,
    { holds: jest.fn().mockResolvedValue(true) } as never,
  );

  const ticketInsert = () => insertedValues.find((v) => "ticketNumber" in v);
  return { svc, ticketInsert };
}

beforeEach(() => {
  jest.clearAllMocks();
  (actorSeam.resolveOrganizationActorsByUserIds as jest.Mock).mockResolvedValue(
    new Map([["user-caller", { membershipId: 5, userId: "user-caller" }]]),
  );
  (projectAccessSeam.resolveProjectAssignableMemberships as jest.Mock).mockResolvedValue(new Map());
});

describe("createTicket persists dueDate rather than accepting and dropping it (#179)", () => {
  it("writes the supplied dueDate onto the ticket insert, so the calendar's date is not a dead write", async () => {
    const { svc, ticketInsert } = makeHarness();
    await svc.createTicket(makeUser(), 1, {
      title: "Ship the release",
      type: "TASK",
      dueDate: "2026-10-15",
    });
    expect(ticketInsert()).toMatchObject({ dueDate: "2026-10-15" });
  });

  it("leaves dueDate unset when the request omits it, so an absent date is not written as a value", async () => {
    const { svc, ticketInsert } = makeHarness();
    await svc.createTicket(makeUser(), 1, { title: "Ship the release", type: "TASK" });
    expect(ticketInsert()!.dueDate).toBeUndefined();
  });
});
