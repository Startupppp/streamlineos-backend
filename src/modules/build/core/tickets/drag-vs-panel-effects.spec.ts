import type { Db } from "../../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { rankTicket } from "./projects-tickets-rank-utils";
import { bulkMutateTickets } from "./build-ticket-bulk-mutation";

jest.mock("../lib/build-ticket-mutation-policy", () => ({
  authorizeTicketMutation: jest.fn().mockResolvedValue({ role: "MEMBER", predicate: {} }),
  lockProjectTicketMutation: jest.fn().mockResolvedValue(undefined),
  readMutationTickets: jest.fn().mockImplementation(
    (_db: unknown, _actor: unknown, _projectId: unknown, ids: number[]) =>
      Promise.resolve(
        ids.map((id) => ({
          id,
          status: "TODO",
          rank: String(id * 1000),
          version: 1,
          assigneeMembershipId: null,
          dueDate: null,
          priority: "MEDIUM",
          points: null,
          epicId: null,
          cycleId: null,
        })),
      ),
  ),
}));

jest.mock("./build-ticket-batch-workflow", () => ({
  validateBatchTransition: jest.fn().mockResolvedValue(undefined),
  emitBatchStatusChanges: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("./tickets-helpers", () => ({
  resolveAssigneeId: jest.fn().mockReturnValue(undefined),
}));

jest.mock("../project-crud/project-access", () => ({
  resolveProjectAssignableMemberships: jest.fn().mockResolvedValue(new Map()),
}));

const ORG = "org-drag-panel-test";

const actor: CurrentUserContext = {
  orgId: ORG,
  userId: "actor-1",
  isOrgOwner: true,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
} as never;

function makeRankTx(statusReturn = "TODO") {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([{ rank: "2000", valid: true }]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1, rank: "2000", status: statusReturn, version: 2 }]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };
}

function makeRankDb(statusReturn = "TODO") {
  const tx = makeRankTx(statusReturn);
  return {
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
}

function makeCache() {
  return { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;
}

function makeAccess() {
  return {
    holds: jest.fn().mockResolvedValue(true),
    scopeFor: jest.fn().mockResolvedValue("all"),
  } as never;
}

function makeEffectDeps(overrides: {
  webhooksEnqueue?: jest.Mock;
  automationRun?: jest.Mock;
  activityLog?: jest.Mock;
  dispatchEmit?: jest.Mock;
} = {}) {
  return {
    webhooksDispatch: { enqueue: overrides.webhooksEnqueue ?? jest.fn().mockResolvedValue(undefined) },
    automationRunner: { runForTicketEvent: overrides.automationRun ?? jest.fn() },
    activity: { logTicketFieldChanges: overrides.activityLog ?? jest.fn().mockResolvedValue(undefined) },
    dispatch: { emit: overrides.dispatchEmit ?? jest.fn().mockResolvedValue(undefined) },
    transfer: { notifyAssignedTickets: jest.fn().mockResolvedValue(undefined) },
  };
}

function makeRankTxForReview(statusReturn = "IN_REVIEW") {
  const limitMock = jest.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ reporterId: "reporter-1", title: "My Ticket" }]);
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: limitMock }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([{ rank: "2000", valid: true }]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1, rank: "2000", status: statusReturn, version: 2 }]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };
}

function makeRankDbForReview(statusReturn = "IN_REVIEW") {
  const tx = makeRankTxForReview(statusReturn);
  return {
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as import("../../../../db/drizzle.types").Db;
}

function makeBulkDb() {
  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
          orderBy: jest.fn().mockReturnValue({
            for: jest.fn().mockResolvedValue([{
              id: 1, status: "TODO", rank: "1000", version: 1,
              assigneeMembershipId: null, dueDate: null, priority: "MEDIUM",
              points: null, epicId: null, cycleId: null, allowed: true,
            }]),
          }),
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1, version: 2 }]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue([]) }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };
  return {
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
}

describe("rank route fires the same webhook and automation effects as the detail route, the only two families RankTicketEffectDeps can carry", () => {
  it("fires webhook ticket.updated (positive)", async () => {
    const webhooksEnqueue = jest.fn().mockResolvedValue(undefined);
    await rankTicket(makeRankDb(), makeCache(), makeAccess(), actor, 1, 1, {}, makeEffectDeps({ webhooksEnqueue }));
    expect(webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.updated")).toHaveLength(1);
  });

  it("does NOT fire webhook ticket.status_changed without status change (negative pair)", async () => {
    const webhooksEnqueue = jest.fn().mockResolvedValue(undefined);
    await rankTicket(makeRankDb(), makeCache(), makeAccess(), actor, 1, 1, {}, makeEffectDeps({ webhooksEnqueue }));
    expect(webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.status_changed")).toHaveLength(0);
  });

  it("fires webhook ticket.status_changed when status changes (positive)", async () => {
    const webhooksEnqueue = jest.fn().mockResolvedValue(undefined);
    await rankTicket(makeRankDb("IN_PROGRESS"), makeCache(), makeAccess(), actor, 1, 1, { status: "IN_PROGRESS" }, makeEffectDeps({ webhooksEnqueue }));
    expect(webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.status_changed")).toHaveLength(1);
  });

  it("does NOT fire webhook ticket.status_changed when status is same (negative pair)", async () => {
    const webhooksEnqueue = jest.fn().mockResolvedValue(undefined);
    await rankTicket(makeRankDb("TODO"), makeCache(), makeAccess(), actor, 1, 1, { status: "TODO" }, makeEffectDeps({ webhooksEnqueue }));
    expect(webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.status_changed")).toHaveLength(0);
  });

  it("fires automation ticket.updated (positive)", async () => {
    const automationRun = jest.fn();
    await rankTicket(makeRankDb(), makeCache(), makeAccess(), actor, 1, 1, {}, makeEffectDeps({ automationRun }));
    expect(automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.updated")).toHaveLength(1);
  });

  it("does NOT fire automation ticket.status_changed without status change (negative pair)", async () => {
    const automationRun = jest.fn();
    await rankTicket(makeRankDb(), makeCache(), makeAccess(), actor, 1, 1, {}, makeEffectDeps({ automationRun }));
    expect(automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.status_changed")).toHaveLength(0);
  });

  it("fires automation ticket.status_changed when status changes (positive)", async () => {
    const automationRun = jest.fn();
    await rankTicket(makeRankDb("IN_PROGRESS"), makeCache(), makeAccess(), actor, 1, 1, { status: "IN_PROGRESS" }, makeEffectDeps({ automationRun }));
    expect(automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.status_changed")).toHaveLength(1);
  });

  it("does NOT fire automation ticket.status_changed when status is same (negative pair)", async () => {
    const automationRun = jest.fn();
    await rankTicket(makeRankDb("TODO"), makeCache(), makeAccess(), actor, 1, 1, { status: "TODO" }, makeEffectDeps({ automationRun }));
    expect(automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.status_changed")).toHaveLength(0);
  });
});

describe("bulk route fires the same webhook and automation effects as the detail route, the only two families BulkTicketEffectDeps can carry", () => {
  it("fires webhook ticket.updated (positive)", async () => {
    const webhooksEnqueue = jest.fn().mockResolvedValue(undefined);
    await bulkMutateTickets(makeBulkDb(), makeAccess(), actor, 1, { ticketIds: [1], priority: "HIGH" }, makeEffectDeps({ webhooksEnqueue }));
    expect(webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.updated")).toHaveLength(1);
  });

  it("does NOT fire webhook ticket.status_changed without status field (negative pair)", async () => {
    const webhooksEnqueue = jest.fn().mockResolvedValue(undefined);
    await bulkMutateTickets(makeBulkDb(), makeAccess(), actor, 1, { ticketIds: [1], priority: "HIGH" }, makeEffectDeps({ webhooksEnqueue }));
    expect(webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.status_changed")).toHaveLength(0);
  });

  it("fires webhook ticket.status_changed when status changes (positive)", async () => {
    const webhooksEnqueue = jest.fn().mockResolvedValue(undefined);
    await bulkMutateTickets(makeBulkDb(), makeAccess(), actor, 1, { ticketIds: [1], status: "IN_PROGRESS" }, makeEffectDeps({ webhooksEnqueue }));
    expect(webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.status_changed")).toHaveLength(1);
  });

  it("does NOT fire webhook ticket.status_changed when status is same as current (negative pair)", async () => {
    const webhooksEnqueue = jest.fn().mockResolvedValue(undefined);
    await bulkMutateTickets(makeBulkDb(), makeAccess(), actor, 1, { ticketIds: [1], status: "TODO" }, makeEffectDeps({ webhooksEnqueue }));
    expect(webhooksEnqueue.mock.calls.filter((c: unknown[]) => c[3] === "ticket.status_changed")).toHaveLength(0);
  });

  it("fires automation ticket.updated (positive)", async () => {
    const automationRun = jest.fn();
    await bulkMutateTickets(makeBulkDb(), makeAccess(), actor, 1, { ticketIds: [1], priority: "HIGH" }, makeEffectDeps({ automationRun }));
    expect(automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.updated")).toHaveLength(1);
  });

  it("does NOT fire automation ticket.status_changed without status field (negative pair)", async () => {
    const automationRun = jest.fn();
    await bulkMutateTickets(makeBulkDb(), makeAccess(), actor, 1, { ticketIds: [1], priority: "HIGH" }, makeEffectDeps({ automationRun }));
    expect(automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.status_changed")).toHaveLength(0);
  });

  it("fires automation ticket.status_changed when status changes (positive)", async () => {
    const automationRun = jest.fn();
    await bulkMutateTickets(makeBulkDb(), makeAccess(), actor, 1, { ticketIds: [1], status: "IN_PROGRESS" }, makeEffectDeps({ automationRun }));
    expect(automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.status_changed")).toHaveLength(1);
  });

  it("does NOT fire automation ticket.status_changed when status is same as current (negative pair)", async () => {
    const automationRun = jest.fn();
    await bulkMutateTickets(makeBulkDb(), makeAccess(), actor, 1, { ticketIds: [1], status: "TODO" }, makeEffectDeps({ automationRun }));
    expect(automationRun.mock.calls.filter((c: unknown[]) => c[2] === "ticket.status_changed")).toHaveLength(0);
  });
});

describe("rank route fires activity log for a status change (review card B7, ticket-44 box-1)", () => {
  it("fires activity.logTicketFieldChanges when status changes via rank (positive)", async () => {
    const activityLog = jest.fn().mockResolvedValue(undefined);
    await rankTicket(makeRankDb("IN_PROGRESS"), makeCache(), makeAccess(), actor, 1, 1, { status: "IN_PROGRESS" }, makeEffectDeps({ activityLog }));
    expect(activityLog).toHaveBeenCalledTimes(1);
  });

  it("asks the activity log for nothing when rank carries no status change, exactly as the detail route does (negative pair)", async () => {
    const activityLog = jest.fn().mockResolvedValue(undefined);
    await rankTicket(makeRankDb(), makeCache(), makeAccess(), actor, 1, 1, {}, makeEffectDeps({ activityLog }));
    expect(activityLog).toHaveBeenCalledTimes(1);
    expect(activityLog.mock.calls[0]?.[4]).toEqual({ status: undefined });
  });
});

describe("rank route fires review notification when status changes to IN_REVIEW (review card B7, ticket-44 box-1)", () => {
  it("fires dispatch.emit with build.ticket.review_requested when status becomes IN_REVIEW (positive)", async () => {
    const dispatchEmit = jest.fn().mockResolvedValue(undefined);
    await rankTicket(makeRankDbForReview("IN_REVIEW"), makeCache(), makeAccess(), actor, 1, 1, { status: "IN_REVIEW" }, makeEffectDeps({ dispatchEmit }));
    const calls = dispatchEmit.mock.calls.filter(
      (c: unknown[]) => (c[0] as { eventKey?: string })?.eventKey === "build.ticket.review_requested",
    );
    expect(calls).toHaveLength(1);
  });

  it("does NOT fire dispatch.emit review_requested for a non-IN_REVIEW status change (negative pair)", async () => {
    const dispatchEmit = jest.fn().mockResolvedValue(undefined);
    await rankTicket(makeRankDb("IN_PROGRESS"), makeCache(), makeAccess(), actor, 1, 1, { status: "IN_PROGRESS" }, makeEffectDeps({ dispatchEmit }));
    const calls = dispatchEmit.mock.calls.filter(
      (c: unknown[]) => (c[0] as { eventKey?: string })?.eventKey === "build.ticket.review_requested",
    );
    expect(calls).toHaveLength(0);
  });
});
