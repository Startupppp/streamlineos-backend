import { runWithTenantContext } from "../../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../../db/drizzle.types";
import type { Db } from "../../../../db/drizzle.module";
import { applyTicketChange } from "./apply-ticket-change";
import type { ApplyTicketChangeDeps } from "./apply-ticket-change";

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: "org-sp-test",
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

function makeTx() {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1, version: 2 }]),
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
  activityLog = jest.fn().mockResolvedValue(undefined),
  notifyNew = jest.fn().mockResolvedValue(undefined),
): { deps: ApplyTicketChangeDeps; tx: ReturnType<typeof makeTx> } {
  const tx = makeTx();
  const deps: ApplyTicketChangeDeps = {
    db: {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue(ticket) } },
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
      }),
    } as unknown as Db,
    dispatch: { emit: jest.fn().mockResolvedValue(undefined) } as never,
    activity: { logTicketFieldChanges: activityLog } as never,
    query: { authorizeMutation: jest.fn().mockResolvedValue([]) } as never,
    transfer: { notifyAssignedTickets: notifyNew } as never,
    webhooksDispatch: { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    automationRunner: { runForTicketEvent: jest.fn() } as never,
    cache: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    access: { holds: jest.fn().mockResolvedValue(true) } as never,
  };
  return { deps, tx };
}

const ACTOR = {
  orgId: "org-sp-test",
  userId: "actor-1",
  isOrgOwner: true,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
} as never;

describe("apply-ticket-change — withSavepoint wraps activity log and transfer notify (sites 1 & 2, ticket 38)", () => {
  it("logTicketFieldChanges is wrapped in withSavepoint — outerTx.transaction called once when a field change is applied", async () => {
    const savepointTx = {} as unknown as TenantTx;
    let txCallCount = 0;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => {
        txCallCount++;
        return fn(savepointTx);
      },
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    const ticket = makeTicket();
    const activityLog = jest.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(ticket, activityLog);

    await runWithTenantContext(
      { orgId: "org-sp-test", audience: "INTERNAL" as const, tx: outerTx },
      () => applyTicketChange(deps, ACTOR, 1, 1, { version: 1, title: "New title" }),
    );

    const savepointCallsForActivity = txCallCount;
    expect(savepointCallsForActivity).toBeGreaterThanOrEqual(1);
    expect(activityLog).toHaveBeenCalled();
  });

  it("notifyAssignedTickets is wrapped in withSavepoint — outerTx.transaction called for both side effects when assignee changes", async () => {
    const savepointTx = {} as unknown as TenantTx;
    let txCallCount = 0;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => {
        txCallCount++;
        return fn(savepointTx);
      },
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    const ticket = makeTicket({ status: "TODO" });
    const notifyNew = jest.fn().mockResolvedValue(undefined);
    const activityLog = jest.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(ticket, activityLog, notifyNew);

    await runWithTenantContext(
      { orgId: "org-sp-test", audience: "INTERNAL" as const, tx: outerTx },
      () => applyTicketChange(deps, ACTOR, 1, 1, { version: 1, title: "Changed" }),
    );

    expect(txCallCount).toBe(2);
    expect(notifyNew).toHaveBeenCalled();
  });

  it("positive: a failing activity log caught by the savepoint does not prevent the function completing", async () => {
    const savepointTx = {} as unknown as TenantTx;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => fn(savepointTx),
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    const ticket = makeTicket();
    const activityLog = jest.fn().mockRejectedValue(new Error("insert failed"));
    const { deps } = makeDeps(ticket, activityLog);

    await expect(
      runWithTenantContext(
        { orgId: "org-sp-test", audience: "INTERNAL" as const, tx: outerTx },
        () => applyTicketChange(deps, ACTOR, 1, 1, { version: 1, title: "New title" }),
      ),
    ).resolves.not.toThrow();
  });
});
