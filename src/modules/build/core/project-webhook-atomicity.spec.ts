import type { Db } from "../../../db/drizzle.module";
import { SprintsService } from "../execution/sprints.service";
import type { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { ProjectsTicketsService } from "./projects-tickets.service";

function harness(enqueueFails: boolean) {
  let mutationCommitted = false;
  let intentCommitted = false;
  const timeline: string[] = [];

  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(() => ({ returning: async () => {
          timeline.push("mutation-staged");
          return [{ id: 4 }];
        } })),
      }),
    }),
  };
  const db = {
    query: {
      sprints: {
        findFirst: jest.fn().mockResolvedValue({
          id: 4,
          name: "Sprint 4",
          status: "PLANNED",
          projectId: 9,
        }),
      },
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

  return {
    service: new SprintsService(db, webhooks),
    enqueue,
    timeline,
    committed: () => ({ mutationCommitted, intentCommitted }),
  };
}

describe("Build mutation and webhook intent atomicity", () => {
  it("rolls back the domain mutation when durable webhook enqueue fails", async () => {
    const test = harness(true);

    await expect(test.service.updateSprint("org-1", 4, { status: "ACTIVE" }, "member-1"))
      .rejects.toThrow("outbox unavailable");

    expect(test.timeline).toEqual(["mutation-staged", "intent-staged", "rollback"]);
    expect(test.committed()).toEqual({ mutationCommitted: false, intentCommitted: false });
  });

  it("stages the intent before the transaction commits, leaving no post-commit enqueue gap", async () => {
    const test = harness(false);

    await test.service.updateSprint("org-1", 4, { status: "ACTIVE" }, "member-1");

    expect(test.timeline).toEqual(["mutation-staged", "intent-staged", "commit"]);
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
    const service = new ProjectsTicketsService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { enqueue } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.deleteTicket("org-1", "member-1", 1, 7, true))
      .rejects.toThrow("Ticket not found");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
