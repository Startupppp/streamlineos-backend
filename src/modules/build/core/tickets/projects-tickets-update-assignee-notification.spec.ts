import type { Db } from "../../../../db/drizzle.module";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";

/**
 * `notifyAssignedTickets` ends in `NotificationDispatchService.emit`, which writes the
 * `notification_outbox` row on the AMBIENT tenant transaction. While it was fired with
 * `void`, the write raced this request's COMMIT: anything that had not finished by then
 * ran against a committed handle whose GUC was gone, so the row was never written and the
 * new assignee was never told they had been assigned.
 *
 * The observable contract is therefore about ORDERING, not about the call happening at
 * all: the notification must have SETTLED before `updateTicket` resolves, because that is
 * the last moment the ambient transaction is guaranteed to still be open.
 */
describe("ProjectsTicketsUpdateService — assignee notification settles inside the request", () => {
  const ORG = "org-owner";

  const ticket = {
    id: 1,
    orgId: ORG,
    projectId: 1,
    status: "open",
    ticketNumber: 1,
    assigneeId: null,
    reporterId: "u1",
    assignees: [],
    title: "Ticket",
    version: 1,
  };

  function makeDb() {
    const txFn = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([ticket]) }),
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
        select: jest
          .fn()
          .mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      }),
    );
    return {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue(ticket) }, projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) } },
      select: jest
        .fn()
        .mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      transaction: txFn,
    } as unknown as Db;
  }

  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
  const activity = { logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } as never;
  const query = { authorizeMutation: jest.fn().mockResolvedValue([]), validateTicketStatus: jest.fn().mockResolvedValue(undefined) } as never;
  const webhooksDispatch = { enqueue: jest.fn().mockResolvedValue(undefined) } as never;
  const automationRunner = { runForTicketEvent: jest.fn() } as never;
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as never;
  const access = { holds: jest.fn().mockResolvedValue(true) } as never;

  it("has finished notifying the new assignee by the time updateTicket resolves", async () => {
    let settled = false;
    const transfer = {
      notifyAssignedTickets: jest.fn().mockImplementation(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        settled = true;
      }),
    } as never;

    const svc = new ProjectsTicketsUpdateService(
      makeDb(),
      dispatch,
      activity,
      query,
      transfer,
      webhooksDispatch,
      automationRunner,
      cache,
      access,
    );
    const u = { orgId: ORG, userId: "u1", isOrgOwner: true, principal: { kind: "human-session", membershipId: 1, isOrgOwner: true } } as never;

    await svc.updateTicket(u, 1, 1, { version: 1, title: "Renamed" });

    expect(settled).toBe(true);
  });
});
