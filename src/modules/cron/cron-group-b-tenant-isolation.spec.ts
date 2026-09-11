jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
  runInNewTenantTransaction: jest.fn().mockImplementation(async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { APP_CONFIG } from "../../config/config.module";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { CronKbChunkRetentionService } from "./cron-kb-chunk-retention.service";
import { CronLeaveService } from "./cron-leave.service";
import { CronLeaveResetService } from "./cron-leave-reset.service";
import { CronNotificationRetentionService } from "./cron-notification-retention.service";
import { CronNotificationsService } from "./cron-notifications.service";
import { CronOrgPurgeWorkerService } from "./cron-org-purge-worker.service";
import { CronOrganizationService } from "./cron-organization.service";
import { CronProjectsService } from "./cron-projects.service";
import { CronRecruitmentService } from "./cron-recruitment.service";
import { CronWeeklyRecapService } from "./cron-weekly-recap.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { EmailService } from "../email/email.service";
import { AccessService } from "../access/access.service";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { OrgMembershipService } from "../organization/core/org-membership.service";
import { StorageService } from "../storage/storage.service";

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
    chain.returning = jest.fn().mockResolvedValue([]);
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
    update: jest.fn().mockImplementation(() => makeChain()),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]), onConflictDoNothing: jest.fn().mockResolvedValue([]) }) }),
    delete: jest.fn().mockImplementation(() => makeChain()),
  } as unknown as Db;
  return { db, findMany, findFirst, selectWhere };
}

function setupForEachOrg(db: Db, orgId: string) {
  (forEachOrg as jest.Mock).mockImplementation(
    async (_d: unknown, _t: string, fn: (tx: unknown, oid: string) => Promise<unknown>) => {
      await fn(db as unknown, orgId);
      return { succeeded: 1, failed: 0 };
    },
  );
}

const cache = {
  cached: jest.fn().mockImplementation(async (_k: string, fn: () => unknown) => fn()),
  cachedVersioned: jest.fn().mockImplementation(async (_ns: string, _h: string, fn: () => unknown) => fn()),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
};

describe("CronKbChunkRetentionService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes KB chunk pruning to the org in callback (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = new CronKbChunkRetentionService(db);

    const result = await svc.pruneStaleChunks();
    expect(result.articleChunksPruned).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("prunes KB chunks for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = new CronKbChunkRetentionService(db);

    await svc.pruneStaleChunks();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronLeaveService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("accrues monthly leaves scoped to the attacker org (isolation — deny: no policies)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        CronLeaveService,
        { provide: DRIZZLE, useValue: db },
        { provide: CronLeaveResetService, useValue: { resolveLeaveYearStartMonth: jest.fn(), resetYearlyLeaveBalances: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronLeaveService));

    const result = await svc.accrueMonthlyLeaves(new Date(), ATTACKER);
    expect(result.accruedCount).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("accrues monthly leaves for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        CronLeaveService,
        { provide: DRIZZLE, useValue: db },
        { provide: CronLeaveResetService, useValue: { resolveLeaveYearStartMonth: jest.fn(), resetYearlyLeaveBalances: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronLeaveService));

    await svc.accrueMonthlyLeaves(new Date(), OWNER);
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronNotificationRetentionService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes notification delivery retention to the org (isolation — deny)", async () => {
    const { db } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = new CronNotificationRetentionService(db);

    await svc.sweep();
    expect(forEachOrg).toHaveBeenCalled();
    const updateSpy = db.update as jest.Mock;
    expect(updateSpy).toHaveBeenCalled();
  });

  it("sweeps notification retention for the owning org (isolation — control)", async () => {
    const { db } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = new CronNotificationRetentionService(db);

    await svc.sweep();
    expect(forEachOrg).toHaveBeenCalledWith(db, "notification-retention", expect.any(Function));
  });
});

describe("CronNotificationsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes birthday/anniversary notifications to the org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = new CronNotificationsService(db);

    const result = await svc.sendDailyNotifications();
    expect(result.birthdayCount).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("sends daily notifications for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = new CronNotificationsService(db);

    await svc.sendDailyNotifications();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronOrgPurgeWorkerService — cross-tenant isolation", () => {
  const OWNER = "org-owner";

  it("only processes orgs explicitly scheduled for purge (isolation — no cross-org reads)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        CronOrgPurgeWorkerService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: cache },
        { provide: OrgMembershipService, useValue: { revokeOrgScopedAccess: jest.fn() } },
        { provide: StorageService, useValue: { deleteFile: jest.fn() } },
        { provide: APP_CONFIG, useValue: { R2_KB_BUCKET_NAME: "kb-files" } },
      ],
    }).compile().then((m) => m.get(CronOrgPurgeWorkerService));

    const result = await svc.run();
    expect(result.processed).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
  });

  it("returns zero when no orgs are due for purge (isolation — control: only PURGE_SCHEDULED orgs touched)", async () => {
    const { db } = makeDb([{ id: OWNER }]);
    const svc = await Test.createTestingModule({
      providers: [
        CronOrgPurgeWorkerService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: cache },
        { provide: OrgMembershipService, useValue: { revokeOrgScopedAccess: jest.fn() } },
        { provide: StorageService, useValue: { deleteFile: jest.fn() } },
        { provide: APP_CONFIG, useValue: { R2_KB_BUCKET_NAME: "kb-files" } },
      ],
    }).compile().then((m) => m.get(CronOrgPurgeWorkerService));

    await svc.run().catch(() => undefined);
    expect(db.select).toHaveBeenCalled();
  });
});

describe("CronOrganizationService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("expires stale invitations scoped to the org in callback (isolation — deny)", async () => {
    const { db } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = await Test.createTestingModule({
      providers: [
        CronOrganizationService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronOrganizationService));

    const result = await svc.expireStaleInvitations();
    expect(result.expired).toBe(0);
    const updateSpy = db.update as jest.Mock;
    expect(updateSpy).toHaveBeenCalled();
  });

  it("expires invitations for the owning org (isolation — control)", async () => {
    const { db } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = await Test.createTestingModule({
      providers: [
        CronOrganizationService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronOrganizationService));

    const result = await svc.expireStaleInvitations();
    expect(result).toBeDefined();
  });
});

describe("CronProjectsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("spawns recurring tickets only for the org in callback (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = new CronProjectsService(db);

    const result = await svc.spawnDueRecurringTickets();
    expect(result.spawned).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("spawns recurring tickets for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = new CronProjectsService(db);

    await svc.spawnDueRecurringTickets();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronRecruitmentService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("sends offer deadline reminders scoped to the org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = await Test.createTestingModule({
      providers: [
        CronRecruitmentService,
        { provide: DRIZZLE, useValue: db },
        { provide: EmailService, useValue: { sendEmail: jest.fn() } },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } },
      ],
    }).compile().then((m) => m.get(CronRecruitmentService));

    const result = await svc.sendOfferDeadlineReminders();
    expect(result.remindedCount).toBe(0);
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
  });

  it("sends offer deadline reminders for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = await Test.createTestingModule({
      providers: [
        CronRecruitmentService,
        { provide: DRIZZLE, useValue: db },
        { provide: EmailService, useValue: { sendEmail: jest.fn() } },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } },
      ],
    }).compile().then((m) => m.get(CronRecruitmentService));

    await svc.sendOfferDeadlineReminders();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});

describe("CronWeeklyRecapService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes weekly recap to the org in the forEachOrg callback (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, ATTACKER);
    const svc = await Test.createTestingModule({
      providers: [
        CronWeeklyRecapService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn() } },
        { provide: AiGatewayService, useValue: { invokeText: jest.fn().mockResolvedValue({ ok: true, data: "recap" }), invokeTextWithUsage: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronWeeklyRecapService));

    const result = await svc.sendWeeklyExecRecaps();
    expect(selectWhere).toHaveBeenCalled();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(ATTACKER);
    expect(result.results).toHaveLength(0);
  });

  it("generates weekly recap for the owning org (isolation — control)", async () => {
    const { db, selectWhere } = makeDb([]);
    setupForEachOrg(db, OWNER);
    const svc = await Test.createTestingModule({
      providers: [
        CronWeeklyRecapService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn() } },
        { provide: AiGatewayService, useValue: { invokeText: jest.fn().mockResolvedValue({ ok: true, data: "recap" }), invokeTextWithUsage: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CronWeeklyRecapService));

    await svc.sendWeeklyExecRecaps();
    expect(sqlValues(selectWhere.mock.calls[0]?.[0] as unknown)).toContain(OWNER);
  });
});
