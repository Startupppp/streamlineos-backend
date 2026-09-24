import { NotFoundException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import { assertTicketReadAccess } from "./build-ticket-read-access";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";

jest.mock("./build-ticket-read-access", () => ({
  assertTicketReadAccess: jest.fn(),
}));

describe("ProjectsTicketSubresourcesService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const PROJECT_ID = 5;

  function makeUser(orgId: string): CurrentUserContext {
    return {
      userId: "user-1",
      orgId,
      role: "OWNER",
      isOrgOwner: true,
      sessionId: "session-1",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, true),
    };
  }

  function makeDb(ticketRow: unknown | null, subtaskRows: unknown[] = []) {
    return {
      query: {
        tickets: {
          findFirst: jest.fn().mockResolvedValue(ticketRow),
          findMany: jest.fn().mockResolvedValue(subtaskRows),
        },
        ticketActivityLog: { findMany: jest.fn().mockResolvedValue([]) },
        ticketWatchers: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
  }

  const activity = { logTicketActivity: jest.fn() };
  const comments = {} as never;
  const checklists = {} as never;
  const links = {} as never;
  const relations = {} as never;
  const access = { scopeFor: jest.fn(), resolveUserPermissions: jest.fn() };

  beforeEach(() => {
    jest.mocked(assertTicketReadAccess).mockImplementation(async (db) => {
      const ticket = await db.query.tickets.findFirst();
      if (!ticket) throw new NotFoundException("Ticket not found");
    });
  });

  it("throws NotFoundException when ticket belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new ProjectsTicketSubresourcesService(db, activity as never, comments, checklists, links, relations, access);
    await expect(svc.getWatchers(makeUser(ATTACKER_ORG), PROJECT_ID, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns subtasks scoped to owning org (same-tenant control)", async () => {
    const subtask = { id: 2, parentTicketId: 1, orgId: OWNER_ORG, assignees: [], labels: [] };
    const db = makeDb({ id: 1, orgId: OWNER_ORG }, [subtask]);
    const svc = new ProjectsTicketSubresourcesService(db, activity as never, comments, checklists, links, relations, access);
    const result = await svc.getSubtasks(makeUser(OWNER_ORG), PROJECT_ID, 1);
    expect(result).toHaveLength(1);
  });

  it("flattens the assignee onto each subtask, because the row schema carries assigneeId and a flat assignee rather than the nested membership", async () => {
    const user = { id: "user-1", name: "Ada", firstName: "Ada", lastName: null, email: "ada@example.com", image: null };
    const subtask = { id: 2, parentTicketId: 1, orgId: OWNER_ORG, assignee: { user }, assignees: [], labels: [] };
    const db = makeDb({ id: 1, orgId: OWNER_ORG }, [subtask]);
    const svc = new ProjectsTicketSubresourcesService(db, activity as never, comments, checklists, links, relations, access);
    const [row] = await svc.getSubtasks(makeUser(OWNER_ORG), PROJECT_ID, 1);
    expect(row).toMatchObject({ assigneeId: "user-1", assignee: user });
  });
});
