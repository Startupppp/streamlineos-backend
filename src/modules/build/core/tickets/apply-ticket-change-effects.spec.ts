import type { Db } from "../../../../db/drizzle.module";
import type { ApplyTicketChangeDeps } from "./apply-ticket-change";
import { applyTicketChange } from "./apply-ticket-change";
import type { UpdateTicketInput } from "../dto/ticket.schemas";

function ti(input: UpdateTicketInput): UpdateTicketInput { return input; }

const ORG = "org-effects-test";

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: ORG,
    projectId: 1,
    status: "TODO",
    title: "Ticket",
    priority: "MEDIUM",
    version: 1,
    assigneeMembershipId: null,
    assignee: null,
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

function makeTx(ticketReturn: Record<string, unknown> = { id: 1, version: 2 }) {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([ticketReturn]),
        }),
      }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      projectStatuses: { findMany: jest.fn().mockResolvedValue([]) },
      workflowTransitions: { findMany: jest.fn().mockResolvedValue([]) },
    },
  };
}

function makeDeps(
  ticket: ReturnType<typeof makeTicket>,
  overrides: Partial<{
    webhooksEnqueue: jest.Mock;
    activityLog: jest.Mock;
    automationRun: jest.Mock;
    dispatchEmit: jest.Mock;
    notifyNew: jest.Mock;
  }> = {},
): { deps: ApplyTicketChangeDeps; tx: ReturnType<typeof makeTx> } {
  const tx = makeTx();
  const webhooksEnqueue = overrides.webhooksEnqueue ?? jest.fn().mockResolvedValue(undefined);
  const activityLog = overrides.activityLog ?? jest.fn().mockResolvedValue(undefined);
  const automationRun = overrides.automationRun ?? jest.fn();
  const dispatchEmit = overrides.dispatchEmit ?? jest.fn().mockResolvedValue(undefined);
  const notifyNew = overrides.notifyNew ?? jest.fn().mockResolvedValue(undefined);
  const deps: ApplyTicketChangeDeps = {
    db: {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue(ticket) } },
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
      }),
    } as unknown as Db,
    dispatch: { emit: dispatchEmit } as never,
    activity: { logTicketFieldChanges: activityLog } as never,
    query: { authorizeMutation: jest.fn().mockResolvedValue([]) } as never,
    transfer: { notifyAssignedTickets: notifyNew } as never,
    webhooksDispatch: { enqueue: webhooksEnqueue } as never,
    automationRunner: { runForTicketEvent: automationRun } as never,
    cache: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    access: { holds: jest.fn().mockResolvedValue(true) } as never,
  };
  return { deps, tx };
}

const actor = {
  orgId: ORG,
  userId: "actor-1",
  isOrgOwner: true,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
} as never;

it.each([
  {
    label: "title-only change does not fire automation ticket.status_changed",
    ticket: makeTicket(),
    input: { version: 1, title: "New title" },
    assertFn: (automationRun: jest.Mock) => {
      const statusEvents = automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.status_changed");
      expect(statusEvents).toHaveLength(0);
    },
  },
  {
    label: "status change fires automation ticket.status_changed",
    ticket: makeTicket({ status: "TODO" }),
    input: { version: 1, status: "DONE" },
    assertFn: (automationRun: jest.Mock) => {
      const statusEvents = automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.status_changed");
      expect(statusEvents.length).toBeGreaterThan(0);
    },
  },
  {
    label: "any change always fires automation ticket.updated",
    ticket: makeTicket(),
    input: { version: 1, title: "Renamed" },
    assertFn: (automationRun: jest.Mock) => {
      const updatedEvents = automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.updated");
      expect(updatedEvents.length).toBeGreaterThan(0);
    },
  },
  {
    label: "any change always enqueues webhook ticket.updated",
    ticket: makeTicket(),
    input: { version: 1, title: "Changed" },
    assertFn: (_: jest.Mock, webhooksEnqueue: jest.Mock) => {
      const updatedWebhooks = webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.updated");
      expect(updatedWebhooks.length).toBeGreaterThan(0);
    },
  },
  {
    label: "no status change does not enqueue ticket.assigned webhook",
    ticket: makeTicket({ status: "TODO" }),
    input: { version: 1, status: "TODO", title: "Same status" },
    assertFn: (_: jest.Mock, webhooksEnqueue: jest.Mock) => {
      const assignedWebhooks = webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.assigned");
      expect(assignedWebhooks).toHaveLength(0);
    },
  },
  {
    label: "any change always logs activity",
    ticket: makeTicket(),
    input: ti({ version: 1, priority: "HIGH" }),
    assertFn: (_: jest.Mock, __: jest.Mock, activityLog: jest.Mock) => {
      expect(activityLog).toHaveBeenCalled();
    },
  },
])("diff→effect: $label", async ({ ticket, input, assertFn }) => {
  const automationRun = jest.fn();
  const webhooksEnqueue = jest.fn().mockResolvedValue(undefined);
  const activityLog = jest.fn().mockResolvedValue(undefined);
  const { deps } = makeDeps(ticket, { automationRun, webhooksEnqueue, activityLog });
  await applyTicketChange(deps, actor, 1, 1, input);
  assertFn(automationRun, webhooksEnqueue, activityLog);
});

it("status change to IN_REVIEW notifies the reporter (positive case)", async () => {
  const dispatchEmit = jest.fn().mockResolvedValue(undefined);
  const ticket = makeTicket({ status: "TODO", reporterId: "reporter-1" });
  const { deps } = makeDeps(ticket, { dispatchEmit });
  await applyTicketChange(deps, actor, 1, 1, { version: 1, status: "IN_REVIEW" });
  const calls = dispatchEmit.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0]?.[0]?.eventKey).toBe("build.ticket.review_requested");
  expect(calls[0]?.[0]?.targetUserIds).toContain("reporter-1");
});

it("status change to TODO does not fire review notification (negative pair)", async () => {
  const dispatchEmit = jest.fn().mockResolvedValue(undefined);
  const ticket = makeTicket({ status: "IN_REVIEW", reporterId: "reporter-1" });
  const { deps } = makeDeps(ticket, { dispatchEmit });
  await applyTicketChange(deps, actor, 1, 1, { version: 1, status: "TODO" });
  const reviewCalls = dispatchEmit.mock.calls.filter((c: unknown[]) =>
    (c[0] as { eventKey?: string })?.eventKey === "build.ticket.review_requested",
  );
  expect(reviewCalls).toHaveLength(0);
});
