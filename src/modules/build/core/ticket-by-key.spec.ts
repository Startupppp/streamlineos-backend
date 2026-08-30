import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { TICKETS_PERMISSION } from "./tickets-scope";

const ORG_ID = "org-ticket-key";
const PROJECT_ID = 1;

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: ORG_ID,
  role: "EMPLOYEE",
  isOrgOwner: true,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
  ...overrides,
});

function makeTicketRow(ticketNumber: number) {
  return {
    id: ticketNumber,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    ticketNumber,
    title: `Ticket ${ticketNumber}`,
    status: "TODO",
    assigneeId: null,
    reporterId: null,
    type: "TASK",
    priority: null,
    deletedAt: null,
    project: { id: PROJECT_ID, name: "Project", key: "PROJ", orgId: ORG_ID },
    sprint: null,
    assignee: null,
    reporter: null,
    assignees: [],
    comments: [],
    attachments: [],
    labels: [],
  };
}

describe("getTicketByKey — ticket beyond the first hundred opens", () => {
  function buildHarness(ticketNumber: number) {
    const ticket = makeTicketRow(ticketNumber);
    const findManyMock = jest.fn().mockResolvedValue([]);
    const findFirstMock = jest.fn().mockResolvedValue(ticket);

    const db = {
      select: jest.fn(),
      execute: jest.fn(),
      query: {
        projects: { findFirst: jest.fn() },
        tickets: {
          findMany: findManyMock,
          findFirst: findFirstMock,
        },
      },
    } as unknown as Db;

    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(
        new Map<string, DataScope>([[TICKETS_PERMISSION, "all"]]),
      ),
      scopeFor: jest.fn().mockResolvedValue("all"),
    } as unknown as AccessService;

    const audit = { log: jest.fn() } as unknown as AuditService;

    return {
      svc: new ProjectsTicketsReadService(db, access, audit),
      findManyMock,
      findFirstMock,
    };
  }

  it("resolves ticket #101 via a direct key lookup, not a list scan", async () => {
    const { svc, findManyMock, findFirstMock } = buildHarness(101);

    const result = await svc.getTicketByKey(makeUser(), PROJECT_ID, 101);

    expect(result.ticketNumber).toBe(101);
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("resolves ticket #250 via a direct key lookup, not a list scan", async () => {
    const { svc, findManyMock, findFirstMock } = buildHarness(250);

    const result = await svc.getTicketByKey(makeUser(), PROJECT_ID, 250);

    expect(result.ticketNumber).toBe(250);
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("throws NotFoundException for an unknown key", async () => {
    const db = {
      select: jest.fn(),
      execute: jest.fn(),
      query: {
        projects: { findFirst: jest.fn() },
        tickets: {
          findMany: jest.fn(),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    } as unknown as Db;

    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(
        new Map<string, DataScope>([[TICKETS_PERMISSION, "all"]]),
      ),
      scopeFor: jest.fn().mockResolvedValue("all"),
    } as unknown as AccessService;

    const audit = { log: jest.fn() } as unknown as AuditService;
    const svc = new ProjectsTicketsReadService(db, access, audit);

    await expect(svc.getTicketByKey(makeUser(), PROJECT_ID, 999)).rejects.toThrow();
  });
});
