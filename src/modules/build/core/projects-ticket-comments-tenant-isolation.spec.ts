import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";

describe("ProjectsTicketCommentsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(ticketRow: unknown | null) {
    const fakeComment = { id: 42, orgId: (ticketRow as { orgId?: string } | null)?.orgId ?? "org-owner", ticketId: 1, content: "hello", authorId: "u1", createdAt: new Date() };
    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue(ticketRow) },
        ticketComments: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([fakeComment]) }) }),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work(db)),
    };
    return db as unknown as Db;
  }

  const activity = { logTicketActivity: jest.fn() } as never;
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:tickets:view"])) } as never;
  const webhooks = { dispatchTicketEvent: jest.fn(), dispatch: jest.fn(), enqueue: jest.fn() } as never;

  it("throws NotFoundException when ticket belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new ProjectsTicketCommentsService(db, activity, access, webhooks);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false } as never;
    await expect(svc.addComment(u, 99, { content: "hack", parentCommentId: undefined } as never)).rejects.toThrow(NotFoundException);
  });

  it("resolves without throwing for the owning org (same-tenant control)", async () => {
    const ticket = { id: 1, orgId: OWNER_ORG, title: "T", projectId: 10, ticketNumber: 1 };
    const db = makeDb(ticket);
    const svc = new ProjectsTicketCommentsService(db, activity, access, webhooks);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;
    await expect(svc.addComment(u, 1, { content: "hello", parentCommentId: undefined } as never)).resolves.not.toThrow();
  });
});
