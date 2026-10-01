import type { Table } from "drizzle-orm";
import {
  assetReturns,
  employeeDevices,
  hrCompCycles,
  hrHeadcountPlans,
  hrWorkflowDefinitions,
  hrWorkflowInstances,
  users,
} from "src/db/schema";
import { HrAnalyticsPlusService } from "src/modules/hr/analytics-plus/hr-analytics-plus.service";
import { HrCommandCenterAnalyticsService } from "src/modules/hr/analytics-plus/hr-command-center-analytics.service";
import { HrWorkflowInstancesService } from "src/modules/hr/workflows/hr-workflow-instances.service";
import { WorkflowInstanceQuerySchema } from "src/modules/hr/workflows/dto/workflow.schemas";
import { RecruitmentJobBoardsService } from "src/modules/hr/recruitment/recruitment-job-boards.service";
import { createJobBoardPostingSchema } from "src/modules/hr/recruitment/dto/job-boards.schemas";
import { CompPlanningService } from "src/modules/hr/enterprise-comp/comp-planning.service";
import { createBudgetPoolSchema } from "src/modules/hr/enterprise-comp/dto/enterprise-comp.schemas";
import type { HrAuditService } from "src/modules/hr/core/hr-audit.service";
import type { HrEffectiveChangesService } from "src/modules/hr/core/hr-effective-changes.service";
import { AssetsService } from "src/modules/hr/directory/assets.service";
import { patchAssetReturnSchema, patchDeviceSchema } from "src/modules/hr/directory/dto/hr-directory.schemas";
import type { AdapterBinding, Observation, Scenario } from "../matrix.types";
import { cache } from "../adapters/real-services";
import { tenantBound } from "../adapters/hr-adapter";
import { settle } from "../matrix-runner";
import { ORG_A, ORG_B } from "../standings";
import { boundValues, standIn, type Row, type WorldDb } from "../world-db";
import { JOB_A } from "../fixtures";

export const HEADCOUNT_PLAN_A = 9911;
export const WORKFLOW_DEFINITION_A = 4244;
export const COMP_CYCLE_A = 4243;
export const ASSET_RETURN_A = 71;
export const DEVICE_A = 5;
const DEVICE_HOLDER_A = `${ORG_A}:device-holder`;
const CREATED = new Date("2026-08-01T00:00:00Z");

export function hrRows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [hrHeadcountPlans, [{ id: HEADCOUNT_PLAN_A, orgId: ORG_A, fiscalYear: 2026, budgetedHeadcount: 2 }]],
    [hrWorkflowDefinitions, [{ id: WORKFLOW_DEFINITION_A, orgId: ORG_A, deletedAt: null }]],
    [hrWorkflowInstances, [{ id: 1, orgId: ORG_A, definitionId: WORKFLOW_DEFINITION_A, status: "pending", objectType: "leave", createdAt: CREATED }]],
    [hrCompCycles, [{ id: COMP_CYCLE_A, orgId: ORG_A }]],
    [
      assetReturns,
      [
        {
          id: ASSET_RETURN_A,
          orgId: ORG_A,
          userId: DEVICE_HOLDER_A,
          assetId: null,
          assetName: "Laptop",
          status: "PENDING",
          returnedAt: null,
          condition: null,
          notes: null,
          createdAt: CREATED,
        },
      ],
    ],
    [
      employeeDevices,
      [
        {
          id: DEVICE_A,
          orgId: ORG_A,
          userId: DEVICE_HOLDER_A,
          deviceType: "laptop",
          deviceName: "Work laptop",
          serialNumber: "SN-A",
          brand: null,
          model: null,
          assignedDate: "2026-08-01",
          returnDate: null,
          status: "ACTIVE",
          notes: null,
          createdAt: CREATED,
        },
      ],
    ],
    [users, [{ id: DEVICE_HOLDER_A, firstName: "Dee", lastName: "Holder", email: "dee@example.com" }]],
  ]);
}

function pair(
  base: Omit<Scenario, "id" | "tenant" | "expected" | "because" | "pairedWith" | "bindings">,
  id: string,
  allow: { readonly because: string; readonly bindings: readonly AdapterBinding[] },
  deny: { readonly because: string; readonly bindings: readonly AdapterBinding[] },
): Scenario[] {
  return [
    { ...base, id: `${id}-same-tenant`, tenant: "same", expected: "allow", because: allow.because, bindings: allow.bindings },
    { ...base, id: `${id}-cross-tenant`, tenant: "other", expected: "404", because: deny.because, pairedWith: `${id}-same-tenant`, bindings: deny.bindings },
  ];
}

const TENANT_ONLY = { actor: "tenant-only", state: "normal" } satisfies Pick<Scenario, "actor" | "state">;

function headcount(world: WorldDb): Scenario[] {
  const service = new HrAnalyticsPlusService(world.db, cache, new HrCommandCenterAnalyticsService(world.db, cache));
  const run = (callerOrg: string) => () =>
    tenantBound(
      world,
      { callerOrg, victimOrg: callerOrg === ORG_A ? ORG_B : ORG_A, ids: [HEADCOUNT_PLAN_A] },
      () => service.updateHeadcountPlan(callerOrg, HEADCOUNT_PLAN_A, { budgetedHeadcount: 3 }),
      { lookup: "hr_headcount_plans", sites: 1 },
      (value) => ({
        returnsTheUpdatedPlan: value === undefined || (typeof value === "object" && value !== null && "id" in value && value.id === HEADCOUNT_PLAN_A),
      }),
    );
  const entry = "HrAnalyticsPlusService.updateHeadcountPlan(orgId) <- PATCH /hr/analytics-plus/workforce/plans/:planId";
  return pair(
    { ...TENANT_ONLY, resource: "hr:headcount-plan", action: "update" },
    "hr-headcount-plan-update",
    { because: "a plan the caller's organisation holds still updates and returns the row", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the tenant-bound update matches nothing for another organisation's plan id and the service answers 404, never 403 or an empty 200",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function workflowInstances(world: WorldDb): Scenario[] {
  const service = new HrWorkflowInstancesService(world.db, standIn({}), standIn({}), standIn({}));
  const query = WorkflowInstanceQuerySchema.parse({ limit: 20 });
  const run = (callerOrg: string) => () =>
    tenantBound(
      world,
      { callerOrg, victimOrg: callerOrg === ORG_A ? ORG_B : ORG_A, ids: [WORKFLOW_DEFINITION_A] },
      () => service.listForDefinition(callerOrg, WORKFLOW_DEFINITION_A, query),
      { lookup: "hr_workflow_definitions", followUp: "hr_workflow_instances" },
    );
  const entry = "HrWorkflowInstancesService.listForDefinition(orgId) <- GET /hr/workflows/:workflowId/instances";
  return pair(
    { ...TENANT_ONLY, resource: "hr:workflow-instance", action: "list" },
    "hr-workflow-instances-list",
    { because: "the caller's own definition resolves and its instance page is read once", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "another organisation's definition is not resolved, so the answer is 404 and the instance page is never queried",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function parentWrites(world: WorldDb): Scenario[] {
  const boards = new RecruitmentJobBoardsService(world.db);
  const audit = standIn<HrAuditService>({ log: async () => undefined });
  const comp = new CompPlanningService(world.db, audit, standIn<HrEffectiveChangesService>({}));
  const posting = createJobBoardPostingSchema.parse({ platform: "b", status: "DRAFT" });
  const pool = createBudgetPoolSchema.parse({ cycleId: COMP_CYCLE_A, allocatedCents: 1 });
  const boardRun = (callerOrg: string) => () =>
    tenantBound(
      world,
      { callerOrg, victimOrg: callerOrg === ORG_A ? ORG_B : ORG_A, ids: [JOB_A] },
      () => boards.create(callerOrg, `${callerOrg}:recruiter`, JOB_A, posting),
      { lookup: "job_postings", writes: { table: "job_board_postings", verb: "insert" } },
    );
  const poolRun = (callerOrg: string) => () =>
    tenantBound(
      world,
      { callerOrg, victimOrg: callerOrg === ORG_A ? ORG_B : ORG_A, ids: [COMP_CYCLE_A] },
      () => comp.createBudgetPool(callerOrg, `${callerOrg}:comp-admin`, pool),
      { lookup: "hr_comp_cycles", writes: { table: "hr_comp_budget_pools", verb: "insert" } },
    );
  const boardEntry = "RecruitmentJobBoardsService.create(orgId) <- POST /hr/recruitment/jobs/:jobId/board-postings";
  const poolEntry = "CompPlanningService.createBudgetPool(orgId) <- POST /hr/enterprise/comp/planning/cycles/:cycleId/budget-pools";
  return [
    ...pair(
      { ...TENANT_ONLY, resource: "hr:job-board-posting", action: "create" },
      "hr-job-board-posting-create",
      { because: "a posting under the caller's own job is inserted, bound to the caller's org", bindings: [{ adapter: "service", entry: boardEntry, run: boardRun(ORG_A) }] },
      {
        because: "the parent job is resolved under the caller's org first, so a foreign job id answers 404 and nothing reaches the tenant foreign key as a 500",
        bindings: [{ adapter: "service", entry: boardEntry, run: boardRun(ORG_B) }],
      },
    ),
    ...pair(
      { ...TENANT_ONLY, resource: "hr:comp-budget-pool", action: "create" },
      "hr-comp-budget-pool-create",
      { because: "a pool under the caller's own cycle is inserted, bound to the caller's org", bindings: [{ adapter: "service", entry: poolEntry, run: poolRun(ORG_A) }] },
      {
        because: "the parent cycle is resolved under the caller's org first, so a foreign cycle id answers 404 and nothing is inserted",
        bindings: [{ adapter: "service", entry: poolEntry, run: poolRun(ORG_B) }],
      },
    ),
  ];
}

function assets(world: WorldDb): Scenario[] {
  const service = new AssetsService(world.db);
  const returnBody = patchAssetReturnSchema.parse({ status: "RETURNED" });
  const deviceBody = patchDeviceSchema.parse({ deviceName: "renamed" });
  const victim = (callerOrg: string): string => (callerOrg === ORG_A ? ORG_B : ORG_A);
  const returnRun = (callerOrg: string) => () =>
    tenantBound(
      world,
      { callerOrg, victimOrg: victim(callerOrg), ids: [ASSET_RETURN_A] },
      () => service.updateAssetReturn(callerOrg, ASSET_RETURN_A, returnBody),
      { lookup: "asset_returns", writes: { table: "asset_returns", verb: "update" } },
    );
  const deviceRun = (callerOrg: string, verb: "update" | "delete") => () =>
    tenantBound(
      world,
      { callerOrg, victimOrg: victim(callerOrg), ids: [DEVICE_A] },
      () => (verb === "update" ? service.updateDevice(callerOrg, DEVICE_A, deviceBody) : service.deleteDevice(callerOrg, DEVICE_A)),
      { lookup: "employee_devices", writes: { table: "employee_devices", verb } },
    );
  const listRun = (callerOrg: string) => async (): Promise<Observation> => {
    const mark = world.reads.length;
    let rows: ReadonlyArray<{ readonly id: number; readonly orgId: string }> = [];
    const observed = await settle(async () => {
      rows = await service.listDevices(callerOrg);
    });
    const bound = world.reads
      .slice(mark)
      .filter((read) => read.table === "employee_devices")
      .flatMap((read) => boundValues(read.where));
    return {
      outcome: observed.outcome !== "allow" ? observed.outcome : rows.some((row) => row.id === DEVICE_A) ? "allow" : "404",
      checks: {
        listBindsCallerOrg: bound.includes(callerOrg) && !bound.includes(victim(callerOrg)),
        noForeignDeviceListed: rows.every((row) => row.orgId === callerOrg),
      },
    };
  };
  const returnEntry = "AssetsService.updateAssetReturn(orgId)";
  const updateEntry = "AssetsService.updateDevice(orgId)";
  const deleteEntry = "AssetsService.deleteDevice(orgId)";
  const listEntry = "AssetsService.listDevices(orgId)";
  return [
    ...pair(
      { ...TENANT_ONLY, resource: "hr:asset-return", action: "update" },
      "hr-asset-return-update",
      { because: "the caller's own pending return is found under its org and finalised", bindings: [{ adapter: "service", entry: returnEntry, run: returnRun(ORG_A) }] },
      {
        because: "another organisation's return record is not found under the caller's org, so the answer is 404 before any update",
        bindings: [{ adapter: "service", entry: returnEntry, run: returnRun(ORG_B) }],
      },
    ),
    ...pair(
      { ...TENANT_ONLY, resource: "hr:device", action: "update" },
      "hr-device-update",
      { because: "the caller's own device is found under its org and updated", bindings: [{ adapter: "service", entry: updateEntry, run: deviceRun(ORG_A, "update") }] },
      {
        because: "another organisation's device id is not found under the caller's org, so the answer is 404 and nothing is updated",
        bindings: [{ adapter: "service", entry: updateEntry, run: deviceRun(ORG_B, "update") }],
      },
    ),
    ...pair(
      { ...TENANT_ONLY, resource: "hr:device", action: "delete" },
      "hr-device-delete",
      { because: "the caller's own device is found under its org and hard-deleted", bindings: [{ adapter: "service", entry: deleteEntry, run: deviceRun(ORG_A, "delete") }] },
      {
        because: "another organisation's device id is not found, so the unrecoverable delete never runs",
        bindings: [{ adapter: "service", entry: deleteEntry, run: deviceRun(ORG_B, "delete") }],
      },
    ),
    ...pair(
      { ...TENANT_ONLY, resource: "hr:device", action: "list" },
      "hr-device-list",
      { because: "the caller's device list carries its own device and only its own", bindings: [{ adapter: "service", entry: listEntry, run: listRun(ORG_A) }] },
      {
        because: "the list query binds the requesting org, so another organisation's devices never appear",
        bindings: [{ adapter: "service", entry: listEntry, run: listRun(ORG_B) }],
      },
    ),
  ];
}

export function hrScenarios(world: WorldDb): Scenario[] {
  return [...headcount(world), ...workflowInstances(world), ...parentWrites(world), ...assets(world)];
}
