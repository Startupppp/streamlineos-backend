jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../db/drizzle.module";
import { makeFakeDb, type TableRows } from "../../test/fake-select-db";
import { ApprovalAdapterRegistry } from "../attention/approval-adapter.registry";
import { ApprovalsService } from "../timesheets/core/approvals.service";
import { TimesheetApprovalAdapter } from "../timesheets/core/timesheet-approval.adapter";
import { HrWorkflowInstancesService } from "../hr/workflows/hr-workflow-instances.service";
import { HrWorkflowApprovalAdapter } from "../hr/workflows/hr-workflow-approval.adapter";
import { decodeInboxCursor } from "./dto/unified-inbox.schemas";
import {
  EXPECTED_ORDER,
  FIRST_TRIMMED_ON_PAGE_ONE,
  LAST_DELIVERED_ON_PAGE_ONE,
  MEMBERSHIP,
  ORG,
  OTHER_MEMBERSHIP,
  OTHER_ORG,
  TIED_SEEDS,
  T_A,
  UID,
  makeAccess,
  makeInbox,
  orgMemberRows,
  scrollApprovals,
  userRows,
  type Seed,
} from "./approval-cursor.spec-fixtures";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function makeUserCtx(): CurrentUserContext {
  return {
    userId: "u",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: MEMBERSHIP, isOrgOwner: false },
  } as unknown as CurrentUserContext;
}

function periodRows(
  seeds: Seed[],
  orgId = ORG,
  approver = MEMBERSHIP,
  submitted = true,
) {
  return seeds.map((seed) => ({
    id: seed.id,
    org_id: orgId,
    user_membership_id: 9,
    period_start: "2026-09-01",
    period_end: "2026-09-14",
    status: "SUBMITTED",
    total_hours: "80.00",
    submitted_at: submitted ? seed.at : null,
    approval_due_at: new Date("2026-09-25T00:00:00.000Z"),
    current_approver_membership_id: approver,
  }));
}

function makeTimesheets(tables: TableRows) {
  const db = makeFakeDb(tables) as unknown as Db;
  const approvals = new ApprovalsService(
    db,
    makeAccess(),
    {} as unknown as ConstructorParameters<typeof ApprovalsService>[2],
    {} as unknown as ConstructorParameters<typeof ApprovalsService>[3],
    {} as unknown as ConstructorParameters<typeof ApprovalsService>[4],
  );
  const registry = new ApprovalAdapterRegistry();
  new TimesheetApprovalAdapter(approvals, registry).onModuleInit();
  return { db, registry };
}

function timesheetTables(rows: ReturnType<typeof periodRows>): TableRows {
  return {
    timesheet_periods: rows,
    owner_member: [{ id: 9, org_id: ORG, user_id: "requester-user" }],
    users: userRows(),
    organization_members: orgMemberRows(),
  };
}

describe("unified inbox — timesheet approvals keyset across pages", () => {
  it("delivers every submitted period exactly once across a complete scroll, ties included", async () => {
    const { db, registry } = makeTimesheets(timesheetTables(periodRows(TIED_SEEDS)));

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 8);

    expect(delivered).toEqual(EXPECTED_ORDER.map((id) => `approval:timesheet:${String(id)}`));
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("page 2 repeats no row from page 1 and starts at the row immediately after it", async () => {
    const { db, registry } = makeTimesheets(timesheetTables(periodRows(TIED_SEEDS)));
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined }, makeUserCtx());
    const second = await svc.list(
      ORG,
      "u",
      { limit: 2, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined, cursor: first.nextCursor ?? undefined },
      makeUserCtx(),
    );

    expect(first.items.map((i) => i.id)).toEqual([50, 30]);
    expect(second.items.map((i) => i.id)).toEqual([10, 40]);
  });

  it("resumes from the last DELIVERED period, not the last one the over-fetch read", async () => {
    const { db, registry } = makeTimesheets(timesheetTables(periodRows(TIED_SEEDS)));
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined }, makeUserCtx());
    const state = decodeInboxCursor(first.nextCursor);

    expect(state.ap["timesheets:timesheet"]).toEqual(LAST_DELIVERED_ON_PAGE_ONE);
    expect(state.ap["timesheets:timesheet"]?.id).not.toBe(FIRST_TRIMMED_ON_PAGE_ONE);
  });

  it("the item timestamp is submittedAt, so the cursor names a row the ORDER BY can find", async () => {
    const { db, registry } = makeTimesheets(timesheetTables(periodRows(TIED_SEEDS)));
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined }, makeUserCtx());

    expect(first.items[0]?.timestamp).toBe(T_A.toISOString());
    expect(first.items[0]?.timestamp).not.toBe(new Date("2026-09-25T00:00:00.000Z").toISOString());
  });

  it("a SUBMITTED period whose submittedAt is null is excluded rather than pinned to page 1 forever", async () => {
    const rows = [
      ...periodRows(TIED_SEEDS),
      ...periodRows([{ id: 99, at: T_A }], ORG, MEMBERSHIP, false),
    ];
    const { db, registry } = makeTimesheets(timesheetTables(rows));

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 8);

    expect(delivered).toEqual(EXPECTED_ORDER.map((id) => `approval:timesheet:${String(id)}`));
    expect(delivered).not.toContain("approval:timesheet:99");
  });

  it("keeps another approver's and another tenant's periods out of every page", async () => {
    const rows = [
      ...periodRows(TIED_SEEDS),
      ...periodRows([{ id: 90, at: T_A }], ORG, OTHER_MEMBERSHIP),
      ...periodRows([{ id: 91, at: T_A }], OTHER_ORG, MEMBERSHIP),
    ];
    const { db, registry } = makeTimesheets(timesheetTables(rows));

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 8);

    expect(delivered).toEqual(EXPECTED_ORDER.map((id) => `approval:timesheet:${String(id)}`));
    expect(delivered).not.toContain("approval:timesheet:90");
    expect(delivered).not.toContain("approval:timesheet:91");
  });
});

function instanceRows(seeds: Seed[], orgId = ORG, approverUserId: string = UID) {
  return seeds.map((seed) => ({
    id: seed.id,
    org_id: orgId,
    definition_id: 1,
    definition_snapshot: {
      steps: [{ stepOrder: 1, approverType: "named_user", approverValue: approverUserId }],
    },
    object_type: "leave_request",
    object_id: `lr-${String(seed.id)}`,
    requested_by: "requester-user",
    subject_employee_id: "emp-1",
    context: {},
    status: "in_progress",
    current_step_order: 1,
    due_at: null,
    created_at: seed.at,
    updated_at: seed.at,
  }));
}

function makeWorkflows(tables: TableRows) {
  const db = makeFakeDb(tables) as unknown as Db;
  const workflows = new HrWorkflowInstancesService(
    db,
    {} as unknown as ConstructorParameters<typeof HrWorkflowInstancesService>[1],
    makeAccess(),
    { getFactsBatch: jest.fn().mockResolvedValue(new Map()) } as unknown as ConstructorParameters<
      typeof HrWorkflowInstancesService
    >[3],
  );
  const registry = new ApprovalAdapterRegistry();
  new HrWorkflowApprovalAdapter(workflows, registry).onModuleInit();
  return { db, registry };
}

function workflowTables(rows: ReturnType<typeof instanceRows>): TableRows {
  return {
    hr_workflow_instances: rows,
    hr_workflow_delegations: [],
    organization_members: orgMemberRows(),
    users: userRows(),
  };
}

describe("unified inbox — workflow approvals keyset across pages", () => {
  it("delivers every routed instance exactly once across a complete scroll, ties included", async () => {
    const { db, registry } = makeWorkflows(workflowTables(instanceRows(TIED_SEEDS)));

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 8);

    expect(delivered).toEqual(EXPECTED_ORDER.map((id) => `approval:workflow:${String(id)}`));
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("page 2 repeats no row from page 1 and starts at the row immediately after it", async () => {
    const { db, registry } = makeWorkflows(workflowTables(instanceRows(TIED_SEEDS)));
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined }, makeUserCtx());
    const second = await svc.list(
      ORG,
      "u",
      { limit: 2, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined, cursor: first.nextCursor ?? undefined },
      makeUserCtx(),
    );

    expect(first.items.map((i) => i.id)).toEqual([50, 30]);
    expect(second.items.map((i) => i.id)).toEqual([10, 40]);
  });

  it("resumes from the last DELIVERED instance, not the last candidate the filter examined", async () => {
    const { db, registry } = makeWorkflows(workflowTables(instanceRows(TIED_SEEDS)));
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined }, makeUserCtx());
    const state = decodeInboxCursor(first.nextCursor);

    expect(state.ap["hr:workflow"]).toEqual(LAST_DELIVERED_ON_PAGE_ONE);
    expect(state.ap["hr:workflow"]?.id).not.toBe(FIRST_TRIMMED_ON_PAGE_ONE);
  });

  it("scans past candidates routed to somebody else instead of ending the scroll on them", async () => {
    const rows = [
      ...instanceRows([{ id: 70, at: T_A }], ORG, "other-user"),
      ...instanceRows([{ id: 60, at: T_A }], ORG, "other-user"),
      ...instanceRows(TIED_SEEDS),
    ];
    const { db, registry } = makeWorkflows(workflowTables(rows));

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 8);

    expect(delivered).toEqual(EXPECTED_ORDER.map((id) => `approval:workflow:${String(id)}`));
    expect(delivered).not.toContain("approval:workflow:70");
  });

  it("keeps another tenant's instances out of every page", async () => {
    const rows = [...instanceRows(TIED_SEEDS), ...instanceRows([{ id: 91, at: T_A }], OTHER_ORG)];
    const { db, registry } = makeWorkflows(workflowTables(rows));

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 8);

    expect(delivered).toEqual(EXPECTED_ORDER.map((id) => `approval:workflow:${String(id)}`));
    expect(delivered).not.toContain("approval:workflow:91");
  });
});
