import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { BuildTicketCreationService } from "../core/tickets";
import { ActionItemsService } from "./action-items.service";
import { createActionItemSchema, updateActionItemSchema } from "./dto/meetings.schemas";
import { MEMBER_STANDING, projectAccessRow, principalAccess } from "../__tests__/project-access-doubles";

const PROJECT_ID = 7;
const MEETING_ID = 3;
const ITEM_ID = 11;
const CALLER_MEMBERSHIP = 21;

const caller: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(CALLER_MEMBERSHIP, false),
};

type ProjectStanding = "member" | "non-member" | "foreign";

function projectRow(standing: ProjectStanding) {
  if (standing === "foreign") return undefined;
  return projectAccessRow({ manages: standing === "member" });
}

const ITEM = {
  id: ITEM_ID,
  orgId: "org-1",
  meetingId: MEETING_ID,
  projectId: PROJECT_ID,
  title: "Follow up",
  description: null,
  dueDate: null,
  convertedTicketId: null,
};

async function build(standing: ProjectStanding, canCreateTickets = true) {
  const project = projectRow(standing);
  const chain = { from: jest.fn(), innerJoin: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue(project === undefined ? [] : [project]) };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  const returning = jest.fn().mockResolvedValue([ITEM]);
  const write = { set: jest.fn(), values: jest.fn(), where: jest.fn() };
  write.set.mockReturnValue(write);
  write.values.mockReturnValue({ returning });
  write.where.mockReturnValue({ returning });
  const query = {
    projectMeetings: { findFirst: jest.fn().mockResolvedValue({ id: MEETING_ID }) },
    meetingActionItems: { findFirst: jest.fn().mockResolvedValue(ITEM) },
  };
  const tx = { query, update: jest.fn(() => write) };
  const db = {
    query,
    select: jest.fn(() => chain),
    insert: jest.fn(() => write),
    update: jest.fn(() => write),
    transaction: jest.fn(async (work: (handle: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const ticketCreation = {
    createInTransaction: jest.fn().mockResolvedValue({ tickets: [{ id: 50 }], command: {} }),
    publish: jest.fn(),
  };
  const access = {
    scopeFor: principalAccess(MEMBER_STANDING).scopeFor,
    holds: jest.fn().mockResolvedValue(canCreateTickets),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ActionItemsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: BuildTicketCreationService, useValue: ticketCreation },
      { provide: AccessService, useValue: access },
    ],
  }).compile();
  return { service: moduleRef.get(ActionItemsService), db, tx, ticketCreation, access };
}

type Built = Awaited<ReturnType<typeof build>>;

const ROUTES: Array<[string, (built: Built) => Promise<unknown>]> = [
  [
    "POST /build/:projectId/meetings/:meetingId/action-items",
    ({ service }) => service.createItem(caller, PROJECT_ID, MEETING_ID, createActionItemSchema.parse({ title: "Follow up" })),
  ],
  [
    "PATCH /build/:projectId/meetings/:meetingId/action-items/:itemId",
    ({ service }) =>
      service.updateItem(caller, PROJECT_ID, MEETING_ID, ITEM_ID, updateActionItemSchema.parse({ title: "Renamed" })),
  ],
  [
    "DELETE /build/:projectId/meetings/:meetingId/action-items/:itemId",
    ({ service }) => service.deleteItem(caller, PROJECT_ID, MEETING_ID, ITEM_ID),
  ],
  [
    "POST /build/:projectId/meetings/:meetingId/action-items/:itemId/convert-to-task",
    ({ service }) => service.convertToTask(caller, PROJECT_ID, MEETING_ID, ITEM_ID),
  ],
];

function wrote(built: Built): boolean {
  return (
    built.db.insert.mock.calls.length > 0 ||
    built.db.update.mock.calls.length > 0 ||
    built.tx.update.mock.calls.length > 0 ||
    built.ticketCreation.createInTransaction.mock.calls.length > 0
  );
}

describe("meeting action items require access to the meeting's project", () => {
  it.each(ROUTES)("%s answers 403 to a same-org caller who is not on the project, before any write", async (_route, call) => {
    const built = await build("non-member");
    await expect(call(built)).rejects.toThrow(ForbiddenException);
    expect(wrote(built)).toBe(false);
  });

  it.each(ROUTES)("%s answers 404 for a project outside the caller's tenant, before any write", async (_route, call) => {
    const built = await build("foreign");
    await expect(call(built)).rejects.toThrow(NotFoundException);
    expect(wrote(built)).toBe(false);
  });

  it.each(ROUTES)("%s succeeds for the project's manager and reaches the write", async (_route, call) => {
    const built = await build("member");
    await call(built);
    expect(wrote(built)).toBe(true);
  });
});

describe("converting an action item into a task requires ticket create rights", () => {
  it("answers 403 to a project member who cannot create tickets, without creating one", async () => {
    const built = await build("member", false);
    await expect(built.service.convertToTask(caller, PROJECT_ID, MEETING_ID, ITEM_ID)).rejects.toThrow(
      ForbiddenException,
    );
    expect(built.access.holds).toHaveBeenCalledWith(caller, "build:tickets:create");
    expect(built.ticketCreation.createInTransaction).not.toHaveBeenCalled();
  });

  it("creates the ticket for a project member who can create tickets", async () => {
    const built = await build("member", true);
    await expect(built.service.convertToTask(caller, PROJECT_ID, MEETING_ID, ITEM_ID)).resolves.toMatchObject({
      ticketId: 50,
    });
    expect(built.ticketCreation.createInTransaction).toHaveBeenCalledTimes(1);
  });
});
