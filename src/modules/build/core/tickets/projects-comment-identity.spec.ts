import { HttpException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";
import { decideTicketRead } from "../project-crud/project-access";

jest.mock("../project-crud/project-access", () => ({
  assertProjectStateAllowsWrites: jest.fn(),
  assertTicketReadAccess: jest.fn(),
  decideTicketRead: jest.fn(),
}));


const OWNER_ORG = "org-owner";
const PROJECT_ID = 10;
const TICKET_ID = 1;
const COMMENT_ID = 42;

function makeSelectChain(result: unknown[]) {
  const limitFn = jest.fn().mockResolvedValue(result);
  const whereFn = jest.fn().mockReturnValue({ limit: limitFn });
  const leftJoin2Fn = jest.fn().mockReturnValue({ where: whereFn });
  const leftJoin1Fn = jest.fn().mockReturnValue({ leftJoin: leftJoin2Fn });
  const fromFn = jest.fn().mockReturnValue({ leftJoin: leftJoin1Fn });
  return jest.fn().mockReturnValue({ from: fromFn });
}

function makeDb(ticketRow: unknown, commentRows: unknown[]) {
  return {
    query: {
      tickets: {
        findFirst: jest.fn().mockResolvedValue(ticketRow),
      },
      ticketComments: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
    select: makeSelectChain(commentRows),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as Db;
}

const activity = { logTicketActivity: jest.fn() } as never;
const mockScopeFor = jest.fn().mockResolvedValue("all");
const access = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:tickets:view"])),
  scopeFor: mockScopeFor,
} as never;
const webhooks = { dispatch: jest.fn(), enqueue: jest.fn() } as never;

beforeEach(() => {
  jest.resetAllMocks();
  mockScopeFor.mockResolvedValue("all");
  jest.mocked(decideTicketRead).mockResolvedValue({ kind: "allowed", projectId: 10, projectState: "ACTIVE" });
});

describe("ProjectsTicketCommentsService.getComment — ROW-76 historical identity", () => {
  it("CONTROL — active member: author fields come from organizationPeople (not users)", async () => {
    const ticket = {
      id: TICKET_ID,
      orgId: OWNER_ORG,
      title: "T",
      projectId: PROJECT_ID,
      ticketNumber: 1,
      assigneeId: null,
      assignees: [],
      reporterId: "u1",
    };

    const commentRow = {
      id: COMMENT_ID,
      body: "Hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      parentCommentId: null,
      authorId: "u1",
      authorDisplayName: "Alice Chen",
      authorFirstName: null,
      authorLastName: null,
      authorImage: "https://cdn/alice.jpg",
      projectKey: "PROJ",
    };

    const db = makeDb(ticket, [commentRow]);
    const svc = new ProjectsTicketCommentsService(db, activity, access, webhooks, { log: jest.fn(), logCritical: jest.fn() } as never);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;

    const result = await svc.getComment(u, PROJECT_ID, TICKET_ID, COMMENT_ID);

    expect(result.author.name).toBe("Alice Chen");
    expect(result.author.image).toBe("https://cdn/alice.jpg");
    expect(result.author.id).toBe("u1");
  });

  it("CONTROL — departed member (no organizationPeople row): comment still returns, author name is null", async () => {
    const ticket = {
      id: TICKET_ID,
      orgId: OWNER_ORG,
      title: "T",
      projectId: PROJECT_ID,
      ticketNumber: 1,
      assigneeId: null,
      assignees: [],
      reporterId: "u1",
    };

    const commentRow = {
      id: COMMENT_ID,
      body: "Old comment",
      createdAt: new Date(),
      updatedAt: new Date(),
      parentCommentId: null,
      authorId: "departed-user",
      authorDisplayName: null,
      authorFirstName: null,
      authorLastName: null,
      authorImage: null,
      projectKey: "PROJ",
    };

    const db = makeDb(ticket, [commentRow]);
    const svc = new ProjectsTicketCommentsService(db, activity, access, webhooks, { log: jest.fn(), logCritical: jest.fn() } as never);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;

    const result = await svc.getComment(u, PROJECT_ID, TICKET_ID, COMMENT_ID);

    expect(result.author.id).toBe("departed-user");
    expect(result.author.name).toBeNull();
    expect(result.body).toBe("Old comment");
  });

  it("DENY — comment not found (cross-org) returns an HttpException (404 semantics)", async () => {
    const ticket = {
      id: TICKET_ID,
      orgId: OWNER_ORG,
      title: "T",
      projectId: PROJECT_ID,
      ticketNumber: 1,
      assigneeId: null,
      assignees: [],
      reporterId: "u1",
    };
    const db = makeDb(ticket, []);
    const svc = new ProjectsTicketCommentsService(db, activity, access, webhooks, { log: jest.fn(), logCritical: jest.fn() } as never);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;

    await expect(svc.getComment(u, PROJECT_ID, TICKET_ID, COMMENT_ID)).rejects.toThrow(
      HttpException,
    );
  });

  it("DENY — ticket not found (cross-org ticket) throws NotFoundException", async () => {
    const db = makeDb(null, []);
    const svc = new ProjectsTicketCommentsService(db, activity, access, webhooks, { log: jest.fn(), logCritical: jest.fn() } as never);
    const u = { orgId: "org-attacker", userId: "u2", isOrgOwner: false } as never;

    await expect(svc.getComment(u, PROJECT_ID, TICKET_ID, COMMENT_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("CONTROL — firstName+lastName fallback renders when displayName is null", async () => {
    const ticket = {
      id: TICKET_ID,
      orgId: OWNER_ORG,
      title: "T",
      projectId: PROJECT_ID,
      ticketNumber: 1,
      assigneeId: null,
      assignees: [],
      reporterId: "u1",
    };

    const commentRow = {
      id: COMMENT_ID,
      body: "Hi",
      createdAt: new Date(),
      updatedAt: new Date(),
      parentCommentId: null,
      authorId: "u1",
      authorDisplayName: null,
      authorFirstName: "Bob",
      authorLastName: "Smith",
      authorImage: null,
      projectKey: "PROJ",
    };

    const db = makeDb(ticket, [commentRow]);
    const svc = new ProjectsTicketCommentsService(db, activity, access, webhooks, { log: jest.fn(), logCritical: jest.fn() } as never);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;

    const result = await svc.getComment(u, PROJECT_ID, TICKET_ID, COMMENT_ID);

    expect(result.author.name).toBe("Bob Smith");
  });
});
