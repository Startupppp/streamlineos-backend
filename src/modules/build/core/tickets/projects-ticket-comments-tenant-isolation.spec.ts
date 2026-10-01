import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { decideTicketRead } from "../project-crud/project-access";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";

jest.mock("../project-crud/project-access", () => ({
  assertTicketReadAccess: jest.fn(),
  assertProjectStateAllowsWrites: jest.fn(),
  decideTicketRead: jest.fn(),
}));

describe("ProjectsTicketCommentsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  interface CommentDbMock {
    query: {
      tickets: { findFirst: jest.Mock };
      ticketComments: { findFirst: jest.Mock };
    };
    insert: jest.Mock;
    select: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock<
      Promise<unknown>,
      [work: (tx: CommentDbMock) => Promise<unknown>]
    >;
  }

  function selectChain(rows: unknown[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"])
      chain[method] = jest.fn(() => chain);
    chain["then"] = (resolve: (value: unknown) => unknown) => resolve(rows);
    return chain;
  }

  function makeDb(ticketRow: unknown | null) {
    const orgId = (ticketRow as { orgId?: string } | null)?.orgId ?? "org-owner";
    const fakeComment = { id: 42, orgId, ticketId: 1, content: "hello", authorId: "u1", createdAt: new Date() };
    const savedRow = {
      id: 42,
      orgId,
      ticketId: 1,
      body: "hello",
      clientVisible: false,
      isEdited: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorId: "u1",
      authorDisplayName: null,
      authorFirstName: null,
      authorLastName: null,
      authorImage: null,
      authorEmail: null,
    };
    const db: CommentDbMock = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue(ticketRow) },
        ticketComments: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([fakeComment]) }) }),
      select: jest.fn(() => selectChain([savedRow])),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation((work) => work(db));
    return db as unknown as Db;
  }

  const activity = { logTicketActivity: jest.fn(), processCommentMentions: jest.fn() } as never;
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:tickets:view"])) } as never;
  const webhooks = { dispatchTicketEvent: jest.fn(), dispatch: jest.fn(), enqueue: jest.fn() } as never;

  beforeEach(() => {
    jest.mocked(decideTicketRead).mockImplementation(async (db) => {
      const ticket = await db.query.tickets.findFirst();
      if (!ticket) return { kind: "missing" };
      return { kind: "allowed", projectId: ticket.projectId, projectState: "ACTIVE" };
    });
  });

  it("throws NotFoundException when ticket belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new ProjectsTicketCommentsService(db, activity, access, webhooks, { log: jest.fn(), logCritical: jest.fn() } as never);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false } as never;
    await expect(svc.addComment(u, 10, 99, { content: "hack", parentCommentId: undefined } as never)).rejects.toThrow(NotFoundException);
  });

  it("resolves without throwing for the owning org (same-tenant control)", async () => {
    const ticket = { id: 1, orgId: OWNER_ORG, title: "T", projectId: 10, ticketNumber: 1 };
    const db = makeDb(ticket);
    const svc = new ProjectsTicketCommentsService(db, activity, access, webhooks, { log: jest.fn(), logCritical: jest.fn() } as never);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;
    await expect(svc.addComment(u, 10, 1, { content: "hello", parentCommentId: undefined } as never)).resolves.not.toThrow();
  });
});
