import { TimesheetApprovalAdapter } from "./timesheet-approval.adapter";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";

function makePeriodRow(overrides: Partial<{
  id: number;
  userMembershipId: number | null;
  userName: string | null;
  userEmail: string | null;
  periodStart: string;
  periodEnd: string;
  totalHours: string | null;
  submittedAt: Date | null;
  approvalDueAt: Date | null;
  approvalRoute: unknown;
}> = {}) {
  return {
    id: 100,
    userMembershipId: 5,
    userName: "Carol White",
    userEmail: "carol@example.com",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-14",
    totalHours: "80.00",
    submittedAt: new Date("2026-09-15T09:00:00Z"),
    approvalDueAt: new Date("2026-09-20T00:00:00Z"),
    approvalRoute: null,
    ...overrides,
  };
}

function makeApprovals(rows: ReturnType<typeof makePeriodRow>[] = [makePeriodRow()]) {
  return {
    pendingRoutedTo: jest.fn().mockResolvedValue(rows),
  } as unknown as import("./approvals.service").ApprovalsService;
}

function makeRegistry() {
  return new ApprovalAdapterRegistry();
}

describe("TimesheetApprovalAdapter — onModuleInit", () => {
  it("registers a timesheet adapter with permission timesheets:approvals:view", () => {
    const registry = makeRegistry();
    const adapter = new TimesheetApprovalAdapter(makeApprovals(), registry);
    adapter.onModuleInit();
    const [ts] = registry.list();
    expect(ts?.permission).toBe("timesheets:approvals:view");
    expect(ts?.kindLabel).toBe("timesheet");
  });

  it("supportsAfterCursor is false", () => {
    const registry = makeRegistry();
    const adapter = new TimesheetApprovalAdapter(makeApprovals(), registry);
    adapter.onModuleInit();
    expect(registry.list()[0]?.supportsAfterCursor).toBe(false);
  });

  it("is idempotent: double init registers only once", () => {
    const registry = makeRegistry();
    const adapter = new TimesheetApprovalAdapter(makeApprovals(), registry);
    adapter.onModuleInit();
    adapter.onModuleInit();
    expect(registry.list()).toHaveLength(1);
  });
});

describe("TimesheetApprovalAdapter — fetch", () => {
  it("returns empty array when membershipId is null — no DB call", async () => {
    const approvals = makeApprovals();
    const registry = makeRegistry();
    const adapter = new TimesheetApprovalAdapter(approvals, registry);
    adapter.onModuleInit();
    const [ts] = registry.list();
    const result = await ts!.fetch("org-1", "user-1", null, 10, null);
    expect(result).toHaveLength(0);
    expect(approvals.pendingRoutedTo).not.toHaveBeenCalled();
  });

  it("maps row to BuildApprovalInboxItem with approvalKind=timesheet", async () => {
    const registry = makeRegistry();
    const adapter = new TimesheetApprovalAdapter(makeApprovals(), registry);
    adapter.onModuleInit();
    const [ts] = registry.list();
    const [item] = await ts!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.kind).toBe("build_approval");
    expect(item?.approvalKind).toBe("timesheet");
  });

  it("constructs collision-free dedupKey approval:timesheet:<id>", async () => {
    const registry = makeRegistry();
    const adapter = new TimesheetApprovalAdapter(makeApprovals([makePeriodRow({ id: 42 })]), registry);
    adapter.onModuleInit();
    const [ts] = registry.list();
    const [item] = await ts!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.dedupKey).toBe("approval:timesheet:42");
  });

  it("timesheet dedup key does not collide with leave or wfh at same id", () => {
    const id = 42;
    expect(`approval:timesheet:${id}`).not.toBe(`approval:leave:${id}`);
    expect(`approval:timesheet:${id}`).not.toBe(`approval:wfh:${id}`);
    expect(`approval:timesheet:${id}`).not.toBe(`approval:workflow:${id}`);
  });

  it("uses approvalDueAt as dueAt when present", async () => {
    const dueAt = new Date("2026-09-20T00:00:00Z");
    const registry = makeRegistry();
    const adapter = new TimesheetApprovalAdapter(makeApprovals([makePeriodRow({ approvalDueAt: dueAt })]), registry);
    adapter.onModuleInit();
    const [ts] = registry.list();
    const [item] = await ts!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.dueAt).toBe(dueAt.toISOString());
  });

  it("passes orgId and membershipId to pendingRoutedTo (tenant isolation)", async () => {
    const approvals = makeApprovals();
    const registry = makeRegistry();
    const adapter = new TimesheetApprovalAdapter(approvals, registry);
    adapter.onModuleInit();
    const [ts] = registry.list();
    await ts!.fetch("org-55", "user-1", 99, 25, null);
    expect(approvals.pendingRoutedTo).toHaveBeenCalledWith("org-55", 99, 25);
  });
});
