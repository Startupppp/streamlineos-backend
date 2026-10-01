import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { ProjectsTicketsDeleteService } from "./projects-tickets-delete.service";

jest.mock("../project-crud/project-access", () => ({
  assertTicketReadAccess: jest.fn(),
}));

function makeActor(): CurrentUserContext {
  return {
    userId: "member-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function harness(existing: { id: number; projectId: number; title: string } | undefined) {
  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };
  const db = {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue(existing) },
      workItemRelations: { findMany: jest.fn().mockResolvedValue([]) },
    },
    transaction: jest.fn(async (work: (value: typeof tx) => Promise<void>) => {
      await work(tx);
    }),
  } as unknown as Db;
  const log = jest.fn();
  const service = new ProjectsTicketsDeleteService(
    db,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as unknown as ProjectsWebhooksDispatchService,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    { scopeFor: jest.fn(), resolveUserPermissions: jest.fn() },
    { log } as never,
  );
  return { service, log };
}

describe("ProjectsTicketsDeleteService — the soft delete leaves an audit row", () => {
  it("writes a ticket.deleted audit entry naming the actor, the ticket and its project", async () => {
    const { service, log } = harness({ id: 7, projectId: 3, title: "Ticket 7" });

    await service.deleteTicket(makeActor(), 3, 7, false);

    expect(log).toHaveBeenCalledWith({
      action: "ticket.deleted",
      userId: "member-1",
      orgId: "org-1",
      targetId: "7",
      targetType: "ticket",
      metadata: { projectId: 3, title: "Ticket 7", force: false },
    });
  });

  it("writes no audit row when the ticket was never found, so the trail records deletions and not attempts", async () => {
    const { service, log } = harness(undefined);

    await expect(service.deleteTicket(makeActor(), 3, 7, false)).rejects.toThrow(
      "Ticket not found",
    );

    expect(log).not.toHaveBeenCalled();
  });
});
