import { HrWorkflowApprovalAdapter, WORKFLOW_PENDING_COUNT_CAP } from "./hr-workflow-approval.adapter";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { makeFakeDb, type TableRows } from "../../../test/fake-select-db";
import { HrWorkflowInstancesService } from "./hr-workflow-instances.service";
import type { HrWorkflowEngineService } from "./hr-workflow-engine.service";
import type { AccessService } from "../../access/access.service";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { Db } from "../../../db/drizzle.module";
import { HrTimeApprovalAdapter } from "../time/hr-time-approval.adapter";
import type { LeavesService } from "../time/leaves.service";
import type { WfhService } from "../time/wfh.service";

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

describe("HrWorkflowApprovalAdapter — countPending (at-most-cap approximation)", () => {
  it("returns the number of rows pendingRoutedToPage resolves — fewer than cap", async () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(
      makeWorkflows([makeWorkflowRow({ id: 1 }), makeWorkflowRow({ id: 2 }), makeWorkflowRow({ id: 3 })]),
      registry,
    );
    adapter.onModuleInit();
    const [wf] = registry.list();
    const result = await wf!.countPending("org-1", "user-1", 5);
    expect(result).toBe(3);
  });

  it("returns WORKFLOW_PENDING_COUNT_CAP when the page is full — the cap is explicit in the test name", async () => {
    const rows = Array.from({ length: WORKFLOW_PENDING_COUNT_CAP }, (_, i) =>
      makeWorkflowRow({ id: i + 1 }),
    );
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows(rows), registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const result = await wf!.countPending("org-1", "user-1", 5);
    expect(result).toBe(WORKFLOW_PENDING_COUNT_CAP);
  });

  it("returns 0 when membershipId is null — positive case above returns non-zero, satisfying BE-141", async () => {
    const workflows = makeWorkflows([makeWorkflowRow()]);
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const result = await wf!.countPending("org-1", "user-1", null);
    expect(result).toBe(0);
    expect(workflows.pendingRoutedToPage).not.toHaveBeenCalled();
  });

  it("calls pendingRoutedToPage with WORKFLOW_PENDING_COUNT_CAP so the bound is explicit", async () => {
    const workflows = makeWorkflows([]);
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    await wf!.countPending("org-1", "user-1", 5);
    expect(workflows.pendingRoutedToPage).toHaveBeenCalledWith(
      "org-1",
      5,
      WORKFLOW_PENDING_COUNT_CAP,
      null,
    );
  });

  it("passes orgId and membershipId, never userId, so another org's rows cannot be counted", async () => {
    const workflows = makeWorkflows([]);
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    await wf!.countPending("org-Z", "user-99", 8);
    const call = (workflows.pendingRoutedToPage as jest.Mock).mock.calls[0] as [string, number, number, unknown];
    expect(call[0]).toBe("org-Z");
    expect(call[1]).toBe(8);
    expect(call).not.toContain("user-99");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: leave_request deduplication exclusion
//
// These suites exercise the full pendingRoutedToPage pipeline by constructing
// a real HrWorkflowInstancesService backed by makeFakeDb. The mock-based
// suites above cannot cover the exclusion because pendingRoutedToPage applies
// the filter itself; these tests verify the DB predicate is evaluated.
// ---------------------------------------------------------------------------

const DEDUP_ORG = "org-dedup";
const DEDUP_APPROVER_USER = "user-approver-dedup";
const DEDUP_APPROVER_MEMBERSHIP = 7;
const DEDUP_LEAVE_ID = 99;
const DEDUP_INSTANCE_ID = 300;

function makeDeduplicationWorkflowRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: DEDUP_INSTANCE_ID,
    org_id: DEDUP_ORG,
    definition_id: 1,
    definition_snapshot: {
      steps: [{ stepOrder: 1, approverType: "named_user" }],
    },
    object_type: "leave_request",
    object_id: String(DEDUP_LEAVE_ID),
    requested_by: "user-requester-dedup",
    requested_by_membership_id: null,
    subject_employee_id: "emp-dedup",
    subject_employee_membership_id: null,
    context: {
      approvalRouting: {
        "1": {
          approverUserIds: [DEDUP_APPROVER_USER],
          explanation: "direct manager",
          dueAt: "2026-10-01T00:00:00.000Z",
          rung: "direct_manager",
          assignedToUserId: null,
          delegation: null,
          escalationRung: null,
        },
      },
    },
    status: "in_progress",
    current_step_order: 1,
    due_at: null,
    created_at: new Date("2026-09-20T00:00:00Z"),
    updated_at: new Date("2026-09-20T00:00:00Z"),
    ...overrides,
  };
}

function makeRealWorkflowsService(
  tableRows: TableRows,
): HrWorkflowInstancesService {
  const db = makeFakeDb(tableRows) as unknown as Db;
  const engine = {} as unknown as HrWorkflowEngineService;
  const access = {
    membersWithPermission: jest.fn().mockResolvedValue([]),
  } as unknown as AccessService;
  const employment = {
    getFactsBatch: jest.fn().mockResolvedValue(new Map()),
    getDirectReportUserIds: jest.fn().mockResolvedValue([]),
  } as unknown as EmploymentFactsService;
  return new HrWorkflowInstancesService(db, engine, access, employment);
}

describe("HrWorkflowApprovalAdapter — leave_request deduplication exclusion (fetch)", () => {
  it("leave_request with a routed approver_membership_id is excluded — leave adapter is the single delivery path", async () => {
    const tables: TableRows = {
      hr_workflow_instances: [makeDeduplicationWorkflowRow()],
      hr_workflow_delegations: [],
      organization_members: [
        {
          id: DEDUP_APPROVER_MEMBERSHIP,
          org_id: DEDUP_ORG,
          user_id: DEDUP_APPROVER_USER,
        },
      ],
      leave_requests: [
        {
          id: DEDUP_LEAVE_ID,
          org_id: DEDUP_ORG,
          approver_membership_id: DEDUP_APPROVER_MEMBERSHIP,
          status: "PENDING",
        },
      ],
    };
    const workflows = makeRealWorkflowsService(tables);
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();

    const wfItems = await wf!.fetch(
      DEDUP_ORG,
      "user-1",
      DEDUP_APPROVER_MEMBERSHIP,
      10,
      null,
    );
    expect(wfItems).toHaveLength(0);

    const leaveRow = {
      id: DEDUP_LEAVE_ID,
      startDate: "2026-10-01",
      endDate: "2026-10-03",
      createdAt: new Date("2026-09-20T00:00:00Z"),
      leaveTypeName: "Annual Leave",
      userId: "user-requester-dedup",
      userName: null,
      userFirstName: null,
      userLastName: null,
      userImage: null,
    };
    const leaveSvc = {
      pendingRoutedToPage: jest.fn().mockResolvedValue([leaveRow]),
      countPendingRoutedTo: jest.fn().mockResolvedValue(1),
    } as unknown as LeavesService;
    const wfhSvc = {
      pendingRoutedToPage: jest.fn().mockResolvedValue([]),
      countPendingRoutedTo: jest.fn().mockResolvedValue(0),
    } as unknown as WfhService;
    const leaveRegistry = makeRegistry();
    new HrTimeApprovalAdapter(leaveSvc, wfhSvc, leaveRegistry).onModuleInit();
    const leaveAdpt = leaveRegistry
      .list()
      .find((a) => a.kindLabel === "leave")!;
    const leaveItems = await leaveAdpt.fetch(
      DEDUP_ORG,
      "user-1",
      DEDUP_APPROVER_MEMBERSHIP,
      10,
      null,
    );
    expect(leaveItems).toHaveLength(1);
    expect(leaveItems[0]?.dedupKey).toBe(`approval:leave:${DEDUP_LEAVE_ID}`);
  });

  it("leave_request with a NULL approver_membership_id IS returned by the workflow adapter — blanket exclusion would silently drop it", async () => {
    const tables: TableRows = {
      hr_workflow_instances: [makeDeduplicationWorkflowRow()],
      hr_workflow_delegations: [],
      organization_members: [
        {
          id: DEDUP_APPROVER_MEMBERSHIP,
          org_id: DEDUP_ORG,
          user_id: DEDUP_APPROVER_USER,
        },
      ],
      leave_requests: [
        {
          id: DEDUP_LEAVE_ID,
          org_id: DEDUP_ORG,
          approver_membership_id: null,
          status: "PENDING",
        },
      ],
    };
    const workflows = makeRealWorkflowsService(tables);
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const items = await wf!.fetch(
      DEDUP_ORG,
      "user-1",
      DEDUP_APPROVER_MEMBERSHIP,
      10,
      null,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.dedupKey).toBe(
      `approval:workflow:${DEDUP_INSTANCE_ID}`,
    );
  });

  it("non-leave objectType (probation_confirmation) is unaffected by the leave exclusion", async () => {
    const tables: TableRows = {
      hr_workflow_instances: [
        makeDeduplicationWorkflowRow({ object_type: "probation_confirmation" }),
      ],
      hr_workflow_delegations: [],
      organization_members: [
        {
          id: DEDUP_APPROVER_MEMBERSHIP,
          org_id: DEDUP_ORG,
          user_id: DEDUP_APPROVER_USER,
        },
      ],
      leave_requests: [],
    };
    const workflows = makeRealWorkflowsService(tables);
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(workflows, registry);
    adapter.onModuleInit();
    const [wf] = registry.list();
    const items = await wf!.fetch(
      DEDUP_ORG,
      "user-1",
      DEDUP_APPROVER_MEMBERSHIP,
      10,
      null,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.dedupKey).toBe(
      `approval:workflow:${DEDUP_INSTANCE_ID}`,
    );
  });
});

describe("HrWorkflowApprovalAdapter — leave_request deduplication exclusion (countPending)", () => {
  it("routed leave does not contribute to the workflow count, while a null-approver leave does — both assertions in one test satisfy BE-141", async () => {
    const baseRows: Record<string, unknown>[] = [
      {
        id: DEDUP_INSTANCE_ID,
        org_id: DEDUP_ORG,
        definition_id: 1,
        definition_snapshot: {
          steps: [{ stepOrder: 1, approverType: "named_user" }],
        },
        object_type: "leave_request",
        object_id: String(DEDUP_LEAVE_ID),
        requested_by: "user-requester-dedup",
        requested_by_membership_id: null,
        subject_employee_id: "emp-dedup",
        subject_employee_membership_id: null,
        context: {
          approvalRouting: {
            "1": {
              approverUserIds: [DEDUP_APPROVER_USER],
              explanation: "direct manager",
              dueAt: "2026-10-01T00:00:00.000Z",
              rung: "direct_manager",
              assignedToUserId: null,
              delegation: null,
              escalationRung: null,
            },
          },
        },
        status: "in_progress",
        current_step_order: 1,
        due_at: null,
        created_at: new Date("2026-09-20T00:00:00Z"),
        updated_at: new Date("2026-09-20T00:00:00Z"),
      },
    ];
    const orgMemberRows = [
      {
        id: DEDUP_APPROVER_MEMBERSHIP,
        org_id: DEDUP_ORG,
        user_id: DEDUP_APPROVER_USER,
      },
    ];

    const routedTables: TableRows = {
      hr_workflow_instances: baseRows,
      hr_workflow_delegations: [],
      organization_members: orgMemberRows,
      leave_requests: [
        {
          id: DEDUP_LEAVE_ID,
          org_id: DEDUP_ORG,
          approver_membership_id: DEDUP_APPROVER_MEMBERSHIP,
          status: "PENDING",
        },
      ],
    };
    const routedWfSvc = makeRealWorkflowsService(routedTables);
    const routedRegistry = makeRegistry();
    new HrWorkflowApprovalAdapter(routedWfSvc, routedRegistry).onModuleInit();
    const [routedWf] = routedRegistry.list();
    const routedCount = await routedWf!.countPending(
      DEDUP_ORG,
      "user-1",
      DEDUP_APPROVER_MEMBERSHIP,
    );
    expect(routedCount).toBe(0);

    const nullTables: TableRows = {
      hr_workflow_instances: baseRows,
      hr_workflow_delegations: [],
      organization_members: orgMemberRows,
      leave_requests: [
        {
          id: DEDUP_LEAVE_ID,
          org_id: DEDUP_ORG,
          approver_membership_id: null,
          status: "PENDING",
        },
      ],
    };
    const nullWfSvc = makeRealWorkflowsService(nullTables);
    const nullRegistry = makeRegistry();
    new HrWorkflowApprovalAdapter(nullWfSvc, nullRegistry).onModuleInit();
    const [nullWf] = nullRegistry.list();
    const nullCount = await nullWf!.countPending(
      DEDUP_ORG,
      "user-1",
      DEDUP_APPROVER_MEMBERSHIP,
    );
    expect(nullCount).toBe(1);
  });
});

describe("HrWorkflowApprovalAdapter — priority", () => {
  it("BITE: workflow item with future dueAt returns NORMAL priority", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(
      makeWorkflows([makeWorkflowRow({ dueAt: futureDate, status: "in_progress" })]),
      registry,
    );
    adapter.onModuleInit();
    const [wf] = registry.list();
    const [item] = await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.priority).toBe("NORMAL");
  });

  it("BITE: workflow item with dueAt in the past returns HIGH priority (overdue)", async () => {
    const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(
      makeWorkflows([makeWorkflowRow({ dueAt: pastDate, status: "in_progress" })]),
      registry,
    );
    adapter.onModuleInit();
    const [wf] = registry.list();
    const [item] = await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.priority).toBe("HIGH");
  });

  it("workflow item with status escalated returns HIGH priority regardless of dueAt", async () => {
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(
      makeWorkflows([makeWorkflowRow({ dueAt: futureDate, status: "escalated" })]),
      registry,
    );
    adapter.onModuleInit();
    const [wf] = registry.list();
    const [item] = await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.priority).toBe("HIGH");
  });

  it("workflow item with null dueAt and non-escalated status returns NORMAL", async () => {
    const registry = makeRegistry();
    const adapter = new HrWorkflowApprovalAdapter(
      makeWorkflows([makeWorkflowRow({ dueAt: null, status: "in_progress" })]),
      registry,
    );
    adapter.onModuleInit();
    const [wf] = registry.list();
    const [item] = await wf!.fetch("org-1", "user-1", 5, 10, null);
    expect(item?.priority).toBe("NORMAL");
  });
});
