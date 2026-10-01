import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { ProjectsTicketsDeleteService } from "../tickets/projects-tickets-delete.service";
import { assertTicketWriteAccess } from "../project-crud/project-access";

jest.mock("../project-crud/project-access", () => ({
  assertTicketWriteAccess: jest.fn(),
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

function harness(enqueueFails: boolean) {
  let mutationCommitted = false;
  let intentCommitted = false;
  const timeline: string[] = [];

  const where = jest.fn().mockImplementation(async () => {
    timeline.push("mutation-staged");
    return [];
  });
  const tx = {
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };
  const db = {
    query: {
      tickets: {
        findFirst: jest.fn().mockResolvedValue({ id: 4, projectId: 9, title: "Ticket 4" }),
      },
      workItemRelations: { findMany: jest.fn().mockResolvedValue([]) },
    },
    transaction: jest.fn(async (work: (value: typeof tx) => Promise<void>) => {
      try {
        await work(tx);
        mutationCommitted = true;
        intentCommitted = true;
        timeline.push("commit");
      } catch (error) {
        mutationCommitted = false;
        intentCommitted = false;
        timeline.push("rollback");
        throw error;
      }
    }),
  } as unknown as Db;
  const enqueue = jest.fn(async (receivedTx: unknown) => {
    expect(receivedTx).toBe(tx);
    timeline.push("intent-staged");
    if (enqueueFails) throw new Error("outbox unavailable");
  });
  const webhooks = { enqueue } as unknown as ProjectsWebhooksDispatchService;
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) };

  return {
    service: new ProjectsTicketsDeleteService(
      db,
      webhooks,
      cache as never,
      { scopeFor: jest.fn() },
      { log: jest.fn() } as never,
    ),
    enqueue,
    timeline,
    committed: () => ({ mutationCommitted, intentCommitted }),
  };
}

describe("Build mutation and webhook intent atomicity", () => {
  beforeEach(() => {
    jest.mocked(assertTicketWriteAccess).mockResolvedValue();
  });

  it("rolls back the domain mutation when durable webhook enqueue fails", async () => {
    const test = harness(true);

    await expect(test.service.deleteTicket(makeActor(), 9, 4, true))
      .rejects.toThrow("outbox unavailable");

    expect(test.timeline[0]).toBe("mutation-staged");
    expect(test.timeline.slice(-2)).toEqual(["intent-staged", "rollback"]);
    expect(test.committed()).toEqual({ mutationCommitted: false, intentCommitted: false });
  });

  it("stages the intent before the transaction commits, leaving no post-commit enqueue gap", async () => {
    const test = harness(false);

    await test.service.deleteTicket(makeActor(), 9, 4, true);

    expect(test.timeline[0]).toBe("mutation-staged");
    expect(test.timeline.slice(-2)).toEqual(["intent-staged", "commit"]);
    expect(test.committed()).toEqual({ mutationCommitted: true, intentCommitted: true });
    expect(test.enqueue).toHaveBeenCalledTimes(1);
  });

  it("fails closed before mutation or enqueue when a ticket has no real project identity", async () => {
    const enqueue = jest.fn();
    const db = {
      query: {
        tickets: {
          findFirst: jest.fn().mockResolvedValue({ id: 7, projectId: null, title: "orphan" }),
        },
      },
      transaction: jest.fn(),
    } as unknown as Db;
    const service = new ProjectsTicketsDeleteService(
      db,
      { enqueue } as never,
      {} as never,
      { scopeFor: jest.fn() },
      { log: jest.fn() } as never,
    );

    await expect(service.deleteTicket(makeActor(), 1, 7, true))
      .rejects.toThrow("Ticket not found");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
