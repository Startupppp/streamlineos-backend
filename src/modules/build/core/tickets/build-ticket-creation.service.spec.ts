import { BuildTicketCreationService } from "./build-ticket-creation.service";

jest.mock("../lib/allocate-ticket-number", () => ({
  allocateTicketNumbers: jest.fn().mockResolvedValue(12),
}));
jest.mock("../lib/build-ticket-capacity", () => ({
  reserveTicketCapacity: jest.fn().mockResolvedValue(undefined),
}));

describe("BuildTicketCreationService", () => {
  it("owns the universal creation effects for every origin", async () => {
    const inserted = [{
      id: 41,
      orgId: "org-1",
      projectId: 7,
      ticketNumber: 12,
      title: "Created everywhere",
      status: "TODO",
      priority: "MEDIUM",
      type: "TASK",
      assigneeMembershipId: null,
    }];
    const values = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(inserted) });
    const insert = jest.fn().mockReturnValue({ values });
    const tx = { insert };
    const db = {
      transaction: jest.fn(async (run: (inner: typeof tx) => unknown) => run(tx)),
    };
    const webhooks = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const automations = { runForTicketEvent: jest.fn() };
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
    const service = new BuildTicketCreationService(
      db as never,
      webhooks as never,
      automations as never,
      cache as never,
    );

    await service.create({
      orgId: "org-1",
      projectId: 7,
      actor: { userId: "user-1", membershipId: 9 },
      drafts: [{ title: "Created everywhere", status: "TODO", type: "TASK", priority: "MEDIUM" }],
    });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(webhooks.enqueue).toHaveBeenCalledWith(
      tx,
      "org-1",
      7,
      "ticket.created",
      expect.objectContaining({ id: 41, actor: "user-1" }),
    );
    expect(automations.runForTicketEvent).toHaveBeenCalledWith(
      "org-1",
      7,
      "ticket.created",
      expect.objectContaining({ ticketId: 41 }),
    );
    expect(cache.invalidateNamespace).toHaveBeenCalledWith("build:analytics:org-1");
  });
});
