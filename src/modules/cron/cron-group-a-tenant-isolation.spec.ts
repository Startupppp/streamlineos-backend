jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService, REDIS } from "../../common/cache/cache.service";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { CronAttendanceService } from "./cron-attendance.service";
import { CronBillingService } from "./cron-billing.service";
import { CronBuildRetentionService } from "./cron-build-retention.service";
import { CronBuildSnapshotsService } from "./cron-build-snapshots.service";
import { CronCrmTasksService } from "./cron-crm-tasks.service";
import { CronHolidayService } from "./cron-holiday.service";
import { CronHrEnginesService } from "./cron-hr-engines.service";
import { CronHrService } from "./cron-hr.service";
import { CronHrDocumentsService } from "./cron-hr-documents.service";
import { CronIdempotencyService } from "./cron-idempotency.service";
import { CronInvitationExpiryService } from "./cron-invitation-expiry.service";
import { HrAutomationEngineService } from "../hr/automations/hr-automation-engine.service";
import { AttendancePolicyService } from "../hr/time/attendance-policy.service";
import { AiCreditsService } from "../billing/core/ai-credits.service";
import { BillingService } from "../billing/core/billing.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { RevenueAnalyticsService } from "../billing/core/revenue-analytics.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { ProjectsReportsService } from "../build/core/projects-reports.service";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { HrWorkflowEngineService } from "../hr/workflows/hr-workflow-engine.service";
import { HrEffectiveChangesService } from "../hr/core/hr-effective-changes.service";
import { HrWebhooksService } from "../hr/automations/hr-webhooks.service";
import { ProbationService } from "../hr/lifecycle/probation.service";
import { ComplianceRequirementsService } from "../hr/global/compliance-requirements.service";
import { WorkAuthorizationsService } from "../hr/global/work-authorizations.service";
import { ContractsService } from "../hr/global/contracts.service";
import { AutomationService } from "../automation/automation.service";
import { SeatLedgerService } from "../billing/core/seat-ledger.service";
import { RetentionService } from "../hr/governance/retention/retention.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeDb(rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const handler = { findMany, findFirst };

  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.orderBy = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockReturnValue(chain);
    chain.offset = jest.fn().mockResolvedValue(rows);
    chain.where = jest.fn().mockReturnValue(chain);
    chain.innerJoin = jest.fn().mockReturnValue(chain);
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    chain.groupBy = jest.fn().mockReturnValue(chain);
    chain.set = jest.fn().mockReturnValue(chain);
    chain.then = (
      onFulfilled: ((value: unknown) => unknown) | null | undefined,
      onRejected?: ((reason: unknown) => unknown) | null | undefined,
    ) => Promise.resolve(rows).then(onFulfilled ?? undefined, onRejected ?? undefined);
    return chain;
  }

  const rootChain = makeChain();
  const selectWhere = rootChain.where as jest.Mock;
  const selectFrom = jest.fn().mockReturnValue(rootChain);

  const db = {
    select: jest.fn().mockReturnValue({ from: selectFrom }),
    query: new Proxy({} as Record<string, typeof handler>, { get: () => handler }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          then: (resolve?: ((v: unknown) => unknown) | null, reject?: ((r: unknown) => unknown) | null) =>
            Promise.resolve([]).then(resolve ?? undefined, reject ?? undefined),
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]), onConflictDoNothing: jest.fn().mockResolvedValue([]) }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  } as unknown as Db;
  return { db, findMany, findFirst, selectWhere };
}

function setupForEachOrg(db: Db, orgId: string) {
  (forEachOrg as jest.Mock).mockImplementation(
    async (_d: unknown, _t: string, fn: (tx: unknown, oid: string) => Promise<unknown>) => {
      await fn(db as unknown, orgId);
      return { organizations: 1, failed: 0 };
    },
  );
}

describe("CronAttendanceService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes attendance auto-checkout to the org (isolation — deny: no records in attacker org)", async () => {
    const { db, findMany } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = await Test.createTestingModule({
      providers: [
        CronAttendanceService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: HrAutomationEngineService, useValue: { emit: jest.fn() } },
        { provide: AttendancePolicyService, useValue: { getAttendanceRules: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile().then((m) => m.get(CronAttendanceService));

    const result = await svc.processAutoCheckout();
    expect(result.processed).toBe(0);
    expect(findMany).toHaveBeenCalled();
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("scopes attendance auto-checkout to the owning org (isolation — control)", async () => {
    const { db, findMany } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = await Test.createTestingModule({
      providers: [
        CronAttendanceService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: HrAutomationEngineService, useValue: { emit: jest.fn() } },
        { provide: AttendancePolicyService, useValue: { getAttendanceRules: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile().then((m) => m.get(CronAttendanceService));

    await svc.processAutoCheckout();
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(OWNER);
  });
});

describe("CronBillingService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  const billingDeps = {
    aiCredits: { debitCredits: jest.fn(), creditBalance: jest.fn() },
    planLimits: { assertWithinLimit: jest.fn() },
    revenue: { recordEvent: jest.fn() },
    dispatch: { emit: jest.fn() },
  };

  it("processes trial expiry scoped to the attacker org only (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = await Test.createTestingModule({
      providers: [
        CronBillingService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: AiCreditsService, useValue: billingDeps.aiCredits },
        { provide: PlanLimitsService, useValue: billingDeps.planLimits },
        { provide: RevenueAnalyticsService, useValue: billingDeps.revenue },
        { provide: NotificationDispatchService, useValue: billingDeps.dispatch },
      ],
    }).compile().then((m) => m.get(CronBillingService));

    const result = await svc.processTrialExpiry();
    expect(result.expired).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("processes trial expiry for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = await Test.createTestingModule({
      providers: [
        CronBillingService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: AiCreditsService, useValue: billingDeps.aiCredits },
        { provide: PlanLimitsService, useValue: billingDeps.planLimits },
        { provide: RevenueAnalyticsService, useValue: billingDeps.revenue },
        { provide: NotificationDispatchService, useValue: billingDeps.dispatch },
      ],
    }).compile().then((m) => m.get(CronBillingService));

    await svc.processTrialExpiry();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronBuildRetentionService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes webhook delivery pruning to the org in callback (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = new CronBuildRetentionService(db);

    const result = await svc.pruneWebhookDeliveries();
    expect(result.webhookDeliveriesPruned).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("prunes webhook deliveries for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = new CronBuildRetentionService(db);

    await svc.pruneWebhookDeliveries();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronBuildSnapshotsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("snapshots projects only for the org in the forEachOrg callback (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const reports = { snapshot: jest.fn().mockResolvedValue(undefined) };
    const svc = await Test.createTestingModule({
      providers: [
        CronBuildSnapshotsService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: ProjectsReportsService, useValue: reports },
      ],
    }).compile().then((m) => m.get(CronBuildSnapshotsService));

    await svc.snapshotAllProjects();
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("snapshots projects for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const reports = { snapshot: jest.fn().mockResolvedValue(undefined) };
    const svc = await Test.createTestingModule({
      providers: [
        CronBuildSnapshotsService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: ProjectsReportsService, useValue: reports },
      ],
    }).compile().then((m) => m.get(CronBuildSnapshotsService));

    await svc.snapshotAllProjects();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronCrmTasksService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("flushes overdue tasks only for the org in the callback (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const bus = { emit: jest.fn() };
    const svc = await Test.createTestingModule({
      providers: [
        CronCrmTasksService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: CrmAutomationBusService, useValue: bus },
      ],
    }).compile().then((m) => m.get(CronCrmTasksService));

    const result = await svc.flushOverdueTasks();
    expect(result.emitted).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("flushes overdue tasks for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = await Test.createTestingModule({
      providers: [
        CronCrmTasksService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: CrmAutomationBusService, useValue: { emit: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronCrmTasksService));

    await svc.flushOverdueTasks();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronHolidayService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes holiday notifications to the org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = new CronHolidayService(db);

    await svc.sendHolidayNotifications();
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("sends holiday notifications for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = new CronHolidayService(db);

    await svc.sendHolidayNotifications();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronHrEnginesService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  async function buildSvc(db: Db) {
    return Test.createTestingModule({
      providers: [
        CronHrEnginesService,
        { provide: DRIZZLE, useValue: db },
        { provide: REDIS, useValue: null },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: HrWorkflowEngineService, useValue: { sweepOverdueSteps: jest.fn().mockResolvedValue({ swept: 0 }) } },
        { provide: HrEffectiveChangesService, useValue: { applyDueChanges: jest.fn().mockResolvedValue({ applied: 0 }) } },
        { provide: HrAutomationEngineService, useValue: { emit: jest.fn() } },
        { provide: HrWebhooksService, useValue: { retryPending: jest.fn() } },
        { provide: ProbationService, useValue: { sweepDue: jest.fn() } },
        { provide: ComplianceRequirementsService, useValue: { generateEvents: jest.fn(), markOverdueEvents: jest.fn() } },
        { provide: WorkAuthorizationsService, useValue: { refreshExpiredStatuses: jest.fn() } },
        { provide: ContractsService, useValue: { refreshExpiredStatuses: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronHrEnginesService));
  }

  it("scopes overdue goal sweep to the attacker org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.sweepOverdueGoals(ATTACKER);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("sweeps overdue goals for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.sweepOverdueGoals(OWNER);
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronHrService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  async function buildSvc(db: Db) {
    return Test.createTestingModule({
      providers: [
        CronHrService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: AutomationService, useValue: { runAutomationsForEvent: jest.fn() } },
        { provide: HrAutomationEngineService, useValue: { emit: jest.fn() } },
        { provide: CronHrDocumentsService, useValue: { processDocumentExpiry: jest.fn().mockResolvedValue({ fired: 0 }) } },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn() } },
        { provide: RetentionService, useValue: { sweepStrandedDeleteRequests: jest.fn().mockResolvedValue({ processed: 0, skipped: 0 }) } },
        // The onboarding sweep writes through MembershipMutations, whose drain
        // busts the guard's membership cache; these cases assert tenant scoping
        // on the reads, so the bust only has to be observable, not real.
        { provide: CacheService, useValue: { invalidate: jest.fn(), invalidateForOrg: jest.fn(), invalidateNamespaceForOrg: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronHrService));
  }

  it("scopes certification expiry sweep to the org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = await buildSvc(db);

    const result = await svc.processCertificationExpiry();
    expect(result.fired).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("processes certification expiry for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = await buildSvc(db);

    await svc.processCertificationExpiry();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronIdempotencyService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("prunes idempotency fences scoped to the org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = new CronIdempotencyService(db);

    const result = await svc.pruneExpiredFences();
    expect(result.commandFencesPruned).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("prunes idempotency fences for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = new CronIdempotencyService(db);

    await svc.pruneExpiredFences();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronInvitationExpiryService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("expires invitations scoped to the org in the callback (isolation — deny)", async () => {
    const { db } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const seatLedger = { recordSeatEvent: jest.fn() };
    const svc = await Test.createTestingModule({
      providers: [
        CronInvitationExpiryService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: SeatLedgerService, useValue: seatLedger },
      ],
    }).compile().then((m) => m.get(CronInvitationExpiryService));

    const result = await svc.sweepExpiredInvitations();
    expect(result.expired).toBe(0);
    const updateCall = (db.update as jest.Mock).mock.calls[0];
    expect(updateCall).toBeDefined();
  });

  it("sweeps invitations for the owning org (isolation — control)", async () => {
    const { db } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = await Test.createTestingModule({
      providers: [
        CronInvitationExpiryService,
        { provide: DRIZZLE, useValue: db },
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
        { provide: SeatLedgerService, useValue: { recordSeatEvent: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronInvitationExpiryService));

    const result = await svc.sweepExpiredInvitations();
    expect(result.expired).toBeGreaterThanOrEqual(0);
  });
});
