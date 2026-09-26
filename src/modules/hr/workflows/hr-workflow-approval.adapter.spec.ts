import { HrWorkflowApprovalAdapter } from "./hr-workflow-approval.adapter";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";

function makeWorkflowRow(overrides: Partial<{
  id: number;
  orgId: string;
  definitionId: number;
  objectType: string;
  objectId: string;
  requestedBy: string;
  subjectEmployeeId: string;
  context: Record<string, unknown>;
  status: string;
  currentStepOrder: number;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  definitionSnapshot: { steps: unknown[] };
}> = {}) {
  return {
    id: 200,
    orgId: "org-1",
    definitionId: 1,
    objectType: "leave_request",
    objectId: "lr-1",
    requestedBy: "user-3",
    subjectEmployeeId: "emp-1",
    context: {},
    status: "in_progress",
    currentStepOrder: 1,
    dueAt: new Date("2026-10-01T00:00:00Z"),
    createdAt: new Date("2026-09-22T08:00:00Z"),
    updatedAt: new Date("2026-09-22T08:00:00Z"),
    definitionSnapshot: { steps: [] },
    ...overrides,
  };
}

function makeWorkflows(data: ReturnType<typeof makeWorkflowRow>[] = [makeWorkflowRow()]) {
  return {
    pendingRoutedToPage: jest.fn().mockResolvedValue(data),
  } as unknown as import("./hr-workflow-instances.service").HrWorkflowInstancesService;
}

function makeRegistry() {
  return new ApprovalAdapterRegistry();
}

describe("HrWorkflowApprovalAdapter — onModuleInit", () => {
  it("registers a workflow adapter with permission hr:workflows:approve", () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows(), registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    expect(wf?.permission).toBe("hr:workflows:approve");
    expect(wf?.kindLabel).toBe("workflow");
  });

  it("supportsAfterCursor is true so the merge keeps paging workflows past page 1", () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows(), registry);
    adapter.onModuleInit();
    expect(registry.list()[0]?.supportsAfterCursor).toBe(true);
  });

  it("is idempotent: double init registers only once", () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows(), registry);
    adapter.onModuleInit();
    adapter.onModuleInit();
    expect(registry.list()).toHaveLength(1);
  });
});

describe("HrWorkflowApprovalAdapter — fetch", () => {
  it("returns empty array when membershipId is null — no DB call", async () => {
    const workflows = makeWorkflows();
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const result = await wf!.fetch("org-1", "user-1", null, 10, null);
    expect(result).toHaveLength(0);
    expect(workflows.pendingRoutedToPage).not.toHaveBeenCalled();
  });

  it("maps workflow row to BuildApprovalInboxItem with approvalKind=workflow", async () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows(), registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const [item] = await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.kind).toBe("build_approval");
    expect(item?.approvalKind).toBe("workflow");
  });

  it("constructs collision-free dedupKey approval:workflow:<id>", async () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows([makeWorkflowRow({ id: 77 })]), registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const [item] = await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.dedupKey).toBe("approval:workflow:77");
  });

  it("workflow dedup key does not collide with leave, wfh, or timesheet at same id", () => {
    const id = 77;
    expect(`approval:workflow:${id}`).not.toBe(`approval:leave:${id}`);
    expect(`approval:workflow:${id}`).not.toBe(`approval:wfh:${id}`);
    expect(`approval:workflow:${id}`).not.toBe(`approval:timesheet:${id}`);
  });

  it("asks for one page bounded by the requested limit rather than a page number", async () => {
    const workflows = makeWorkflows();
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(workflows.pendingRoutedToPage).toHaveBeenCalledWith("org-1", 5, 10, null);
  });

  it("passes orgId and the server-derived membershipId, never the client user id (tenant isolation)", async () => {
    const workflows = makeWorkflows();
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    await wf!.fetch("org-42", "user-99", 8, 25, null);
    const call = (workflows.pendingRoutedToPage as jest.Mock).mock.calls[0] as [string, number, number, unknown];
    expect(call[0]).toBe("org-42");
    expect(call[1]).toBe(8);
    expect(call).not.toContain("user-99");
  });

  it("hands the adapter cursor through to pendingRoutedToPage unchanged", async () => {
    const workflows = makeWorkflows();
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const cursor = { id: 200, t: "2026-09-22T08:00:00.000Z" };
    await wf!.fetch("org-1", "user-1", 5, 10, cursor);
    expect(workflows.pendingRoutedToPage).toHaveBeenCalledWith("org-1", 5, 10, cursor);
  });
});

describe("HrWorkflowApprovalAdapter — deepLink", () => {
  it("every workflow item carries deepLink /hr/approvals", async () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows(), registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const [item] = await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.deepLink).toBe("/hr/approvals");
  });

  it("CONTROL: workflow deepLink differs from the timesheet deepLink /timesheets/approvals", async () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows(), registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const [item] = await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.deepLink).not.toBe("/timesheets/approvals");
  });
});

describe("HrWorkflowApprovalAdapter — the badge counts this adapter by scanning fetch, so no second predicate can disagree", () => {
  it("registers no private count query, leaving fetch as the only definition of what is pending", () => {
    const registry = makeRegistry();
    new HrWorkflowApprovalAdapter(makeWorkflows(), registry).onModuleInit();
    expect(registry.list()[0]).not.toHaveProperty("countPending");
  });

  it("scans nothing for a principal with no membership, so the badge counts nothing for one", async () => {
    const workflows = makeWorkflows([makeWorkflowRow()]);
    const registry = makeRegistry();
    new HrWorkflowApprovalAdapter(workflows, registry).onModuleInit();
    const [wf] = registry.list();
    await expect(wf!.fetch("org-1", "user-1", null, 50, null)).resolves.toEqual(
      [],
    );
    expect(workflows.pendingRoutedToPage).not.toHaveBeenCalled();
  });

  it("CONTROL: the same scan returns one row per pending instance for a principal that has a membership", async () => {
    const workflows = makeWorkflows([
      makeWorkflowRow({ id: 1 }),
      makeWorkflowRow({ id: 2 }),
      makeWorkflowRow({ id: 3 }),
    ]);
    const registry = makeRegistry();
    new HrWorkflowApprovalAdapter(workflows, registry).onModuleInit();
    const [wf] = registry.list();
    await expect(
      wf!.fetch("org-1", "user-1", 5, 50, null),
    ).resolves.toHaveLength(3);
  });

  it("passes orgId and membershipId, never userId, so another org's rows cannot be scanned", async () => {
    const workflows = makeWorkflows([]);
    const registry = makeRegistry();
    new HrWorkflowApprovalAdapter(workflows, registry).onModuleInit();
    const [wf] = registry.list();
    await wf!.fetch("org-Z", "user-99", 8, 50, null);
    const call = (workflows.pendingRoutedToPage as jest.Mock).mock.calls[0] as [string, number, number, unknown];
    expect(call[0]).toBe("org-Z");
    expect(call[1]).toBe(8);
    expect(call).not.toContain("user-99");
  });

  it("carries the workflow's own (objectType, objectId) so a leave request routed here collides with the leave adapter", async () => {
    const workflows = makeWorkflows([
      makeWorkflowRow({ id: 900, objectType: "leave_request", objectId: "77" }),
    ]);
    const registry = makeRegistry();
    new HrWorkflowApprovalAdapter(workflows, registry).onModuleInit();
    const [wf] = registry.list();
    const [item] = await wf!.fetch("org-1", "user-1", 5, 50, null);
    expect(item?.objectType).toBe("leave_request");
    expect(item?.objectId).toBe("77");
  });
});
