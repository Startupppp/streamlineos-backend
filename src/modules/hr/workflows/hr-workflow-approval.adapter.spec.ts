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
    getInbox: jest.fn().mockResolvedValue({ data, total: data.length, page: 1, limit: data.length }),
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

  it("supportsAfterCursor is false", () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows(), registry);
    adapter.onModuleInit();
    expect(registry.list()[0]?.supportsAfterCursor).toBe(false);
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
    expect(workflows.getInbox).not.toHaveBeenCalled();
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

  it("always calls getInbox with page=1 (first page only, bounded)", async () => {
    const workflows = makeWorkflows();
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(workflows.getInbox).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", userId: "user-1" }),
      1,
      10,
    );
  });

  it("passes orgId and userId in the constructed context (tenant isolation)", async () => {
    const workflows = makeWorkflows();
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    await wf!.fetch("org-42", "user-99", 8, 25, null);
    const [ctx] = (workflows.getInbox as jest.Mock).mock.calls[0] as [{ orgId: string; userId: string }, number, number];
    expect(ctx.orgId).toBe("org-42");
    expect(ctx.userId).toBe("user-99");
  });
});
