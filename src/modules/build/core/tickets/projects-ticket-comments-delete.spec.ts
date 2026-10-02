import { ForbiddenException } from "@nestjs/common";
import { decideTicketRead } from "../project-crud/project-access";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";

jest.mock("../project-crud/project-access", () => ({
  assertTicketReadAccess: jest.fn(),
  assertProjectStateAllowsWrites: jest.fn(),
  decideTicketRead: jest.fn(),
}));

function buildService(comment: { id: number; userId: string } | undefined) {
  const audit = { log: jest.fn(), logCritical: jest.fn() };
  const transaction = jest.fn();
  const db = {
    query: {
      tickets: {
        findFirst: jest.fn().mockResolvedValue({
          id: 7,
          projectId: 3,
          assignee: null,
          assignees: [],
          reporterId: "user-1",
        }),
      },
      ticketComments: { findFirst: jest.fn().mockResolvedValue(comment) },
    },
    transaction,
  };
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:tickets:update", "build:manage"])),
    scopeFor: jest.fn().mockResolvedValue("all"),
  };
  const service = new ProjectsTicketCommentsService(
    db as never,
    { logTicketActivity: jest.fn() } as never,
    access as never,
    {} as never,
    audit as never,
  );
  return { service, transaction, access, audit };
}

const actor = {
  userId: "viewer-2",
  orgId: "org-1",
  isOrgOwner: true,
  role: "OWNER",
  sessionId: "s",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
};

beforeEach(() => {
  jest.mocked(decideTicketRead).mockResolvedValue({ kind: "allowed", projectId: 3, projectState: "ACTIVE" });
});

describe("ProjectsTicketCommentsService.deleteComment", () => {
  it("writes an audit row for the author's own delete", async () => {
    const { service, transaction, audit } = buildService({ id: 42, userId: "viewer-2" });
    transaction.mockImplementation((cb: (t: unknown) => unknown) =>
      cb({ update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }) }),
    );

    await expect(service.deleteComment(actor as never, 3, 7, 42)).resolves.toEqual({
      deleted: true,
    });
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ticket.comment.deleted",
        targetId: "42",
        targetType: "ticket_comment",
      }),
    );
  });

  it("refuses a manager who did not write the comment", async () => {
    const { service, transaction } = buildService({ id: 42, userId: "author-1" });

    await expect(service.deleteComment(actor as never, 3, 7, 42)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("deletes when the actor wrote the comment", async () => {
    const { service, transaction } = buildService({ id: 42, userId: "viewer-2" });
    transaction.mockImplementation(async (fn: (tx: { update: () => { set: () => { where: () => Promise<void> } } }) => Promise<void>) => {
      await fn({
        update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue(undefined) }) }),
      });
    });

    await expect(service.deleteComment(actor as never, 3, 7, 42)).resolves.toEqual({ deleted: true });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
