import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
import type { Db } from "../../../db/drizzle.module";

describe("ProjectsTicketsUpdateService — automation payload reflects current assignee", () => {
  const ORG = "org-test";

  function makeTicket(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      orgId: ORG,
      projectId: 1,
      status: "TODO",
      version: 1,
      title: "Original Title",
      priority: "MEDIUM",
      assigneeMembershipId: 5,
      assignee: { userId: "alice" },
      sprintId: null,
      startDate: null,
      dueDate: null,
      reporterId: "reporter-1",
      updatedAt: new Date("2026-01-01"),
      points: null,
      type: "TASK",
      cycleId: null,
      ...overrides,
    };
  }

  function makeDb(ticket: ReturnType<typeof makeTicket>) {
    const txFn = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        }),
        execute: jest.fn().mockResolvedValue([]),
      }),
    );
    return {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue(ticket) } },
      transaction: txFn,
    } as unknown as Db;
  }

  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
  const activity = { logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } as never;
  const query = { authorizeMutation: jest.fn().mockResolvedValue(undefined) } as never;
  const read = { checkProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: "ADMIN" }) } as never;
  const transfer = { notifyNewAssignees: jest.fn().mockResolvedValue(undefined) } as never;
  const webhooksDispatch = { enqueue: jest.fn().mockResolvedValue(undefined) } as never;
  const cache = { del: jest.fn().mockResolvedValue(undefined) } as never;
  const access = { holds: jest.fn().mockResolvedValue(true) } as never;

  it("ticket.updated payload carries the current assignee userId when the update does not change the assignee", async () => {
    const automationRunner = { runForTicketEvent: jest.fn() } as never;
    const svc = new ProjectsTicketsUpdateService(
      makeDb(makeTicket()),
      dispatch,
      activity,
      query,
      read,
      transfer,
      webhooksDispatch,
      automationRunner,
      cache,
      access,
    );
    const u = {
      orgId: ORG,
      userId: "editor",
      isOrgOwner: true,
      principal: { kind: "human-session", membershipId: 2, isOrgOwner: true },
    } as never;

    await svc.updateTicket(u, 1, { title: "Updated Title" });

    const calls = (automationRunner.runForTicketEvent as jest.Mock).mock.calls;
    const updatedCall = calls.find((c: unknown[]) => c[2] === "ticket.updated");
    expect(updatedCall).toBeDefined();
    expect(updatedCall?.[3]?.assigneeId).toBe("alice");
  });

  it("ticket.updated payload carries null assigneeId when the ticket has no assignee and the update does not touch assignees", async () => {
    const automationRunner = { runForTicketEvent: jest.fn() } as never;
    const svc = new ProjectsTicketsUpdateService(
      makeDb(makeTicket({ assigneeMembershipId: null, assignee: null })),
      dispatch,
      activity,
      query,
      read,
      transfer,
      webhooksDispatch,
      automationRunner,
      cache,
      access,
    );
    const u = {
      orgId: ORG,
      userId: "editor",
      isOrgOwner: true,
      principal: { kind: "human-session", membershipId: 2, isOrgOwner: true },
    } as never;

    await svc.updateTicket(u, 1, { title: "Updated Title" });

    const calls = (automationRunner.runForTicketEvent as jest.Mock).mock.calls;
    const updatedCall = calls.find((c: unknown[]) => c[2] === "ticket.updated");
    expect(updatedCall).toBeDefined();
    expect(updatedCall?.[3]?.assigneeId).toBeNull();
  });
});
