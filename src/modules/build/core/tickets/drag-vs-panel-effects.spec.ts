import type { Db } from "../../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { rankTicket } from "./projects-tickets-rank-utils";
import { bulkMutateTickets } from "./build-ticket-bulk-mutation";

jest.mock("./build-ticket-mutation-policy", () => ({
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

function makeEffectDeps(overrides: { webhooksEnqueue?: jest.Mock; automationRun?: jest.Mock } = {}) {
  return {
    webhooksDispatch: { enqueue: overrides.webhooksEnqueue ?? jest.fn().mockResolvedValue(undefined) },
    automationRunner: { runForTicketEvent: overrides.automationRun ?? jest.fn() },
  };
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

describe("rank route fires same effects as detail route", () => {
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

describe("bulk route fires same effects as detail route", () => {
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
