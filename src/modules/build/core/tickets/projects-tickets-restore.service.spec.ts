import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ticketComments, tickets } from "../../../../db/schema";
import { assertTicketReadAccess } from "../project-crud/project-access";
import { ProjectsTicketsRestoreService } from "./projects-tickets-restore.service";

jest.mock("../project-crud/project-access", () => ({
  assertTicketReadAccess: jest.fn(),
}));

function chain(rows: unknown[]) {
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.from = self;
  node.where = self;
  node.set = self;
  node.limit = () => rows;
  node.returning = () => rows;
  node.then = (resolve: (value: unknown) => unknown) => resolve(rows);
  return node;
}

const DELETED_AT = new Date("2026-03-01T10:00:00.000Z");

const actor = {
  userId: "user-1",
  orgId: "org-1",
  isOrgOwner: true,
  role: "OWNER",
  sessionId: "s",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
};

function buildService(options: {
  ticket?: Record<string, unknown> | undefined;
  project?: Record<string, unknown> | undefined;
  comment?: Record<string, unknown> | undefined;
  parentComment?: Record<string, unknown> | undefined;
  occupants?: unknown[];
  restoredComments?: unknown[];
}) {
  const audit = { log: jest.fn(), logCritical: jest.fn() };
  const updates: unknown[] = [];
  const tx = {
    update: jest.fn((table: unknown) => {
      updates.push(table);
      if (table === ticketComments) return chain(options.restoredComments ?? []);
      return chain([]);
    }),
  };
  const transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx));
  const commentFindFirst = jest
    .fn()
    .mockResolvedValueOnce(options.comment)
    .mockResolvedValue(options.parentComment);
  const db = {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue(options.ticket) },
      projects: { findFirst: jest.fn().mockResolvedValue(options.project) },
      ticketComments: { findFirst: commentFindFirst },
    },
    select: jest.fn(() => chain(options.occupants ?? [])),
    transaction,
  };
  const service = new ProjectsTicketsRestoreService(
    db as never,
    audit as never,
    { scopeFor: jest.fn(), resolveUserPermissions: jest.fn() } as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, audit, transaction, updates };
}

beforeEach(() => {
  jest.mocked(assertTicketReadAccess).mockResolvedValue();
});

describe("ProjectsTicketsRestoreService.restoreTicket", () => {
  it("refuses while the parent project is still deleted and names the project", async () => {
    const { service, transaction } = buildService({
      ticket: { id: 11, title: "Bug", ticketNumber: 4, deletedAt: DELETED_AT },
      project: { id: 3, name: "Apollo", deletedAt: DELETED_AT },
    });

    await expect(
      service.restoreTicket(actor as never, 3, 11),
    ).rejects.toThrow(/Project "Apollo" \(3\) is still deleted/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses when a live ticket already holds the deleted ticket's number", async () => {
    const { service, transaction } = buildService({
      ticket: { id: 11, title: "Bug", ticketNumber: 4, deletedAt: DELETED_AT },
      project: { id: 3, name: "Apollo", deletedAt: null },
      occupants: [{ id: 77 }],
    });

    await expect(
      service.restoreTicket(actor as never, 3, 11),
    ).rejects.toThrow(/Ticket number 4 is already held by live ticket 77/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("clears deletedAt and restores the comments the same delete stamped", async () => {
    const { service, audit, updates } = buildService({
      ticket: { id: 11, title: "Bug", ticketNumber: 4, deletedAt: DELETED_AT },
      project: { id: 3, name: "Apollo", deletedAt: null },
      occupants: [],
      restoredComments: [{ id: 51 }, { id: 52 }],
    });

    await expect(
      service.restoreTicket(actor as never, 3, 11),
    ).resolves.toEqual({ restored: true, restoredChildren: 2 });
    expect(updates).toEqual([tickets, ticketComments]);
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ticket.restored",
        metadata: expect.objectContaining({ restoredComments: 2 }),
      }),
    );
  });

  it("refuses a ticket that is not deleted", async () => {
    const { service, transaction } = buildService({
      ticket: { id: 11, title: "Bug", ticketNumber: 4, deletedAt: null },
    });

    await expect(
      service.restoreTicket(actor as never, 3, 11),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("ProjectsTicketsRestoreService.restoreComment", () => {
  it("refuses while the parent ticket is still deleted and names the ticket", async () => {
    const { service, transaction } = buildService({
      comment: {
        id: 51,
        userId: "user-1",
        parentCommentId: null,
        deletedAt: DELETED_AT,
      },
      ticket: { id: 11, title: "Bug", deletedAt: DELETED_AT },
    });

    await expect(
      service.restoreComment(actor as never, 3, 11, 51),
    ).rejects.toThrow(/Ticket "Bug" \(11\) is still deleted/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses while the parent comment is still deleted and names it", async () => {
    const { service, transaction } = buildService({
      comment: {
        id: 52,
        userId: "user-1",
        parentCommentId: 51,
        deletedAt: DELETED_AT,
      },
      ticket: { id: 11, title: "Bug", deletedAt: null },
      parentComment: { id: 51, deletedAt: DELETED_AT },
    });

    await expect(
      service.restoreComment(actor as never, 3, 11, 52),
    ).rejects.toThrow(/Parent comment 51 is still deleted/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a caller who did not write the comment", async () => {
    const { service, transaction } = buildService({
      comment: {
        id: 51,
        userId: "author-2",
        parentCommentId: null,
        deletedAt: DELETED_AT,
      },
    });

    await expect(
      service.restoreComment(actor as never, 3, 11, 51),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("clears deletedAt and restores the replies the same delete stamped", async () => {
    const { service, audit, updates } = buildService({
      comment: {
        id: 51,
        userId: "user-1",
        parentCommentId: null,
        deletedAt: DELETED_AT,
      },
      ticket: { id: 11, title: "Bug", deletedAt: null },
      restoredComments: [{ id: 52 }],
    });

    await expect(
      service.restoreComment(actor as never, 3, 11, 51),
    ).resolves.toEqual({ restored: true, restoredChildren: 1 });
    expect(updates).toEqual([ticketComments, ticketComments]);
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ticket.comment.restored",
        metadata: expect.objectContaining({ restoredReplies: 1 }),
      }),
    );
  });
});
