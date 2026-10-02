import { Test } from "@nestjs/testing";
import { OrgSetupQueryService } from "../org-setup-query.service";
import { OrgSetupResolverService } from "../org-setup-resolver.service";
import { OrganizationCreationService } from "../../core/organization-creation.service";
import { AccountOrganizationIndexService } from "../../core/account-organization-index.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { OnboardingSessionService } from "../../../hr/onboarding/flow/onboarding-session.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { ModuleChecklistService } from "../../../hr/onboarding/flow/module-checklist.service";
import { OutboxWakeSignal } from "../../../../common/outbox/outbox-wake.signal";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

jest.mock("../../../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../rbac/seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue(undefined),
}));

const STAMP = new Date("2026-01-01T00:00:00.000Z");

function ownerActor(orgId = "org-1"): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

function memberActor(orgId = "org-1"): CurrentUserContext {
  return {
    userId: "user-2",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s2",
    tokenScopes: null,
    principal: humanSessionPrincipal(2, false),
  };
}

type StatusDbOptions = {
  onboardingCompletedAt: Date | null;
  hasSubscription: boolean;
  hasEnabledModule: boolean;
  hasActiveOwner?: boolean;
  entitlementStatus?: string;
  inboxStatus: string | null;
  inboxHasOptionalFailure?: boolean;
  outboxDeliveryState: string | null;
  outboxCorrelationId?: string | null;
};

function buildSelectChain(resolvedValue: unknown[], onWhere?: (predicate: SQL) => void) {
  const limit = jest.fn().mockResolvedValue(resolvedValue);
  const orderBy = jest.fn().mockReturnValue({ limit });

  function makeWhere() {
    const p = Object.assign(Promise.resolve(resolvedValue), { limit, orderBy });
    return p;
  }

  function makeInnerJoin() {
    const p = Object.assign(Promise.resolve(resolvedValue), {
      where: jest.fn().mockImplementation(makeWhere),
      limit,
      orderBy,
    });
    return p;
  }

  const where = jest.fn().mockImplementation((predicate: SQL) => {
    onWhere?.(predicate);
    return makeWhere();
  });
  const innerJoin = jest.fn().mockImplementation(makeInnerJoin);
  const from = jest.fn().mockReturnValue({ where, limit, orderBy, innerJoin });
  return { from };
}

function buildStatusTx(opts: StatusDbOptions) {
  let selectIndex = 0;

  const tx = {
    select: jest.fn().mockImplementation(() => {
      const idx = selectIndex++;
      if (idx === 0) {
        return buildSelectChain(
          [{ onboardingCompletedAt: opts.onboardingCompletedAt }],
        );
      }
      if (idx === 1) {
        return buildSelectChain((opts.hasActiveOwner ?? true) ? [{ id: 1 }] : []);
      }
      if (idx === 2) {
        return buildSelectChain(
          opts.hasSubscription
            ? [{ status: opts.entitlementStatus ?? "TRIAL" }]
            : [],
        );
      }
      if (idx === 3) {
        return buildSelectChain(opts.hasEnabledModule ? [{ moduleKey: "hr" }] : []);
      }
      if (idx === 4) {
        return buildSelectChain(
          opts.outboxDeliveryState !== null
            ? [
                {
                  eventId: "setup-event-1",
                  deliveryState: opts.outboxDeliveryState,
                  correlationId: opts.outboxCorrelationId ?? null,
                  payload: null,
                },
              ]
            : [],
        );
      }
      if (idx === 5) {
        return buildSelectChain(
          opts.inboxStatus !== null
            ? [{ status: opts.inboxStatus, hasOptionalFailure: opts.inboxHasOptionalFailure ?? false }]
            : [],
        );
      }
      return buildSelectChain([]);
    }),
    execute: jest.fn().mockResolvedValue([]),
  };

  return tx;
}

function buildStatusDb(opts: StatusDbOptions) {
  const tx = buildStatusTx(opts);
  return {
    transaction: jest.fn().mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    query: {
      organizations: { findFirst: jest.fn() },
      organizationMembers: { findFirst: jest.fn() },
    },
  };
}

async function buildStatusService(
  db: unknown,
  resolverTarget: { orgId: string; isOwner?: boolean } | null,
) {
  const target = resolverTarget
    ? { ...resolverTarget, isOwner: resolverTarget.isOwner ?? true }
    : null;
  const resolverMock = {
    resolveCurrentSetupTarget: jest.fn().mockResolvedValue(target),
    resolveExistingSetupTarget: jest.fn().mockReturnValue(target),
    listSetupMemberships: jest.fn().mockResolvedValue([]),
    resolveOrCreateOrg: jest.fn(),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgSetupQueryService,
      { provide: OrgSetupResolverService, useValue: resolverMock },
      { provide: DRIZZLE, useValue: db },
      {
        provide: OnboardingSessionService,
        useValue: {
          getOrCreateSession: jest.fn().mockResolvedValue({ id: 42 }),
          skipSession: jest.fn().mockResolvedValue(undefined),
          completeSession: jest.fn().mockResolvedValue(undefined),
        },
      },
    ],
  }).compile();

  return moduleRef.get(OrgSetupQueryService);
}

describe("OrgSetupService.getSetupStatus — optional-phase failure is visible", () => {
  it("COMPLETED with an optional failure → completed + SETUP_BACKGROUND_PARTIAL, still ready", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxCorrelationId: "corr-partial",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("completed");
    expect(status.errorCode).toBe("SETUP_BACKGROUND_PARTIAL");
    expect(status.correlationId).toBe("corr-partial");
    expect(status.ready).toBe(true);
  });

  it("COMPLETED with no optional failure → completed + errorCode null (the bite)", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: false,
      outboxDeliveryState: "DELIVERED",
      outboxCorrelationId: "corr-clean",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("completed");
    expect(status.errorCode).toBeNull();
    expect(status.correlationId).toBeNull();
  });
});

describe("OrgSetupService.getSetupStatus — provisioning + errorCode mapping", () => {
  it("returns not-started with ready:false when target is null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: null,
    });
    const svc = await buildStatusService(db, null);
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("not-started");
    expect(status.ready).toBe(false);
    expect(status.orgId).toBeNull();
  });

  it("returns not-started with ready:false when stamp is absent", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: null,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: null,
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("not-started");
    expect(status.ready).toBe(false);
    expect(status.errorCode).toBeNull();
  });

  it("pending + no outbox → provisioning=pending, errorCode=null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: null,
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("pending");
    expect(status.errorCode).toBeNull();
    expect(status.correlationId).toBeNull();
  });

  it("pending + outbox PENDING → provisioning=pending, errorCode=null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: "PENDING",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("pending");
    expect(status.errorCode).toBeNull();
  });

  it("pending + outbox IN_FLIGHT → provisioning=pending, errorCode=null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: "IN_FLIGHT",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("pending");
    expect(status.errorCode).toBeNull();
  });

  it("pending + outbox DELIVERED → provisioning=pending, errorCode=null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("pending");
    expect(status.errorCode).toBeNull();
  });

  it("no inbox + outbox DEAD → provisioning=failed, errorCode=SETUP_BACKGROUND_DEAD", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: "DEAD",
      outboxCorrelationId: "corr-1",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("failed");
    expect(status.errorCode).toBe("SETUP_BACKGROUND_DEAD");
    expect(status.correlationId).toBe("corr-1");
  });

  it("no inbox + outbox SUPPRESSED → provisioning=failed, errorCode=SETUP_BACKGROUND_SUPPRESSED", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: "SUPPRESSED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("failed");
    expect(status.errorCode).toBe("SETUP_BACKGROUND_SUPPRESSED");
  });

  it("inbox PENDING + any outbox → provisioning=in-progress, errorCode=null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "PENDING",
      outboxDeliveryState: "IN_FLIGHT",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("in-progress");
    expect(status.errorCode).toBeNull();
  });

  it("inbox IN_FLIGHT + any outbox → provisioning=in-progress, errorCode=null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "IN_FLIGHT",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("in-progress");
    expect(status.errorCode).toBeNull();
  });

  it("inbox COMPLETED + any outbox → provisioning=completed, errorCode=null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("completed");
    expect(status.errorCode).toBeNull();
  });

  it("inbox SKIPPED + any outbox → provisioning=completed, errorCode=null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "SKIPPED",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("completed");
    expect(status.errorCode).toBeNull();
  });

  it("inbox FAILED + outbox PENDING → provisioning=in-progress, errorCode=SETUP_BACKGROUND_RETRYING", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "FAILED",
      outboxDeliveryState: "PENDING",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("in-progress");
    expect(status.errorCode).toBe("SETUP_BACKGROUND_RETRYING");
  });

  it("inbox FAILED + outbox IN_FLIGHT → provisioning=in-progress, errorCode=SETUP_BACKGROUND_RETRYING", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "FAILED",
      outboxDeliveryState: "IN_FLIGHT",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("in-progress");
    expect(status.errorCode).toBe("SETUP_BACKGROUND_RETRYING");
  });

  it("inbox FAILED + outbox DEAD → provisioning=failed, errorCode=SETUP_BACKGROUND_DEAD", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "FAILED",
      outboxDeliveryState: "DEAD",
      outboxCorrelationId: "corr-dead",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("failed");
    expect(status.errorCode).toBe("SETUP_BACKGROUND_DEAD");
    expect(status.correlationId).toBe("corr-dead");
  });

  it("inbox FAILED + outbox SUPPRESSED → provisioning=failed, errorCode=SETUP_BACKGROUND_SUPPRESSED", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "FAILED",
      outboxDeliveryState: "SUPPRESSED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("failed");
    expect(status.errorCode).toBe("SETUP_BACKGROUND_SUPPRESSED");
  });

  it("inbox FAILED + outbox DELIVERED → provisioning=failed, errorCode=SETUP_BACKGROUND_INVALID", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "FAILED",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.provisioning).toBe("failed");
    expect(status.errorCode).toBe("SETUP_BACKGROUND_INVALID");
  });
});

describe("OrgSetupService.getSetupStatus — ready computation", () => {
  it("ready:true with provisioning:pending (worker offline, event never claimed)", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: null,
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(true);
    expect(status.provisioning).toBe("pending");
  });

  it("ready:true with provisioning:failed + SETUP_BACKGROUND_DEAD", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: "DEAD",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(true);
    expect(status.provisioning).toBe("failed");
    expect(status.errorCode).toBe("SETUP_BACKGROUND_DEAD");
  });

  it("ready:false when stamp is absent", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: null,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: null,
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(false);
  });

  it("ready:false when no enabled module row exists", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: false,
      inboxStatus: null,
      outboxDeliveryState: null,
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(false);
  });

  it("ready:false when no subscription row exists", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: false,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: null,
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(false);
  });

  it("ready:false, provisioning:not-started when target is null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: null,
    });
    const svc = await buildStatusService(db, null);
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(false);
    expect(status.provisioning).toBe("not-started");
  });
});

describe("OrgSetupService.getSetupStatus — readiness invariant (OS-R3)", () => {
  it("ready:false when the organization has no ACTIVE owner membership", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasActiveOwner: false,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(false);
    expect(status.onboardingCompletedAt).toEqual(STAMP);
    expect(status.provisioning).toBe("completed");
  });

  it.each(["CANCELLED", "EXPIRED", "SUSPENDED"])(
    "ready:false when the latest entitlement is %s",
    async (entitlementStatus) => {
      const db = buildStatusDb({
        onboardingCompletedAt: STAMP,
        hasSubscription: true,
        entitlementStatus,
        hasEnabledModule: true,
        inboxStatus: "COMPLETED",
        outboxDeliveryState: "DELIVERED",
      });
      const svc = await buildStatusService(db, { orgId: "org-1" });
      const status = await svc.getSetupStatus(ownerActor());

      expect(status.ready).toBe(false);
    },
  );

  it.each(["TRIAL", "ACTIVE", "PAST_DUE"])(
    "ready:true when the latest entitlement is %s",
    async (entitlementStatus) => {
      const db = buildStatusDb({
        onboardingCompletedAt: STAMP,
        hasSubscription: true,
        entitlementStatus,
        hasEnabledModule: true,
        inboxStatus: "COMPLETED",
        outboxDeliveryState: "DELIVERED",
      });
      const svc = await buildStatusService(db, { orgId: "org-1" });
      const status = await svc.getSetupStatus(ownerActor());

      expect(status.ready).toBe(true);
    },
  );

  it("an unrecognised entitlement status denies rather than admits", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      entitlementStatus: "SOME_FUTURE_STATE",
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(false);
  });

  it("ready:false when no enabled module survives the catalog join", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: false,
      inboxStatus: "COMPLETED",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(false);
  });

  it("a non-owner caller in a fully provisioned org is ready, and readiness reports no ownership for them", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1", isOwner: false });
    const status = await svc.getSetupStatus(memberActor());

    expect(status.ready).toBe(true);
    expect(Object.keys(status).sort()).toEqual([
      "correlationId",
      "errorCode",
      "onboardingCompletedAt",
      "ready",
      "orgId",
      "provisioning",
      "recipientOutcomes",
    ].sort());
  });

  it("a stale session org claim never decides the answer — the resolved target's orgId is reported", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-resolved" });
    const status = await svc.getSetupStatus(ownerActor("org-stale-claim"));

    expect(status.orgId).toBe("org-resolved");
    expect(status.ready).toBe(true);
  });

  it("worker offline: ready:true with a pending relay, so optional enrichment never blocks entry", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: "PENDING",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.ready).toBe(true);
    expect(status.provisioning).toBe("pending");
  });

  it("readiness performs no write — every statement in the status transaction is a select", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    await svc.getSetupStatus(ownerActor());

    const tx = db.transaction.mock.calls.length;
    expect(tx).toBe(1);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });
});

describe("OrgSetupService.getSetupStatus — response shape", () => {
  it("never includes a lastError field in the response", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "FAILED",
      outboxDeliveryState: "DEAD",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status).not.toHaveProperty("lastError");
  });

  it("correlationId is null when errorCode is null", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      outboxDeliveryState: "DELIVERED",
      outboxCorrelationId: "some-corr-id",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.errorCode).toBeNull();
    expect(status.correlationId).toBeNull();
  });

  it("correlationId is set from outbox row when errorCode is present", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: null,
      outboxDeliveryState: "DEAD",
      outboxCorrelationId: "corr-abc-123",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.errorCode).not.toBeNull();
    expect(status.correlationId).toBe("corr-abc-123");
  });

  it("recipientOutcomes is null when no error code is present", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: false,
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.errorCode).toBeNull();
    expect(status.recipientOutcomes).toBeNull();
  });

  it("recipientOutcomes is null when PARTIAL but payload is absent", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxCorrelationId: "corr-partial",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.errorCode).toBe("SETUP_BACKGROUND_PARTIAL");
    expect(status.recipientOutcomes).toBeNull();
  });

  it("recipientOutcomes is null for a non-owner even when PARTIAL", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
    });
    const svc = await buildStatusService(db, { orgId: "org-1", isOwner: false });
    const status = await svc.getSetupStatus(memberActor());

    expect(status.errorCode).toBe("SETUP_BACKGROUND_PARTIAL");
    expect(status.recipientOutcomes).toBeNull();
  });

  it("response never includes a lastError field", async () => {
    const db = buildStatusDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "FAILED",
      outboxDeliveryState: "DEAD",
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status).not.toHaveProperty("lastError");
  });
});

type OutcomesDbOptions = StatusDbOptions & {
  outboxPayload: Record<string, unknown> | null;
  captureWhere?: (selection: number, predicate: SQL) => void;
  receiptRows: Array<{
    email: string;
    invitationId: string | null;
    outcome: "SKIPPED_SELF" | "REFUSED" | "QUEUED" | "DELIVERY_FAILED";
  }>;
  invitationRows: Array<{ id: string; status: string }>;
};

function buildOutcomesTx(opts: OutcomesDbOptions) {
  let selectIndex = 0;

  const tx = {
    select: jest.fn().mockImplementation(() => {
      const idx = selectIndex++;
      if (idx === 0) {
        return buildSelectChain([{ onboardingCompletedAt: opts.onboardingCompletedAt }]);
      }
      if (idx === 1) {
        return buildSelectChain((opts.hasActiveOwner ?? true) ? [{ id: 1 }] : []);
      }
      if (idx === 2) {
        return buildSelectChain(
          opts.hasSubscription
            ? [{ status: opts.entitlementStatus ?? "TRIAL" }]
            : [],
        );
      }
      if (idx === 3) {
        return buildSelectChain(opts.hasEnabledModule ? [{ moduleKey: "hr" }] : []);
      }
      if (idx === 4) {
        return buildSelectChain(
          opts.outboxDeliveryState !== null
            ? [{
                eventId: "setup-event-1",
                deliveryState: opts.outboxDeliveryState,
                correlationId: opts.outboxCorrelationId ?? null,
                payload: opts.outboxPayload,
              }]
            : [],
        );
      }
      if (idx === 5) {
        return buildSelectChain(
          opts.inboxStatus !== null
            ? [{ status: opts.inboxStatus, hasOptionalFailure: opts.inboxHasOptionalFailure ?? false }]
            : [],
          (predicate) => opts.captureWhere?.(idx, predicate),
        );
      }
      if (idx === 6) {
        return buildSelectChain(opts.receiptRows, (predicate) => opts.captureWhere?.(idx, predicate));
      }
      if (idx === 7) {
        return buildSelectChain(opts.invitationRows);
      }
      return buildSelectChain([]);
    }),
    execute: jest.fn().mockResolvedValue([]),
  };

  return tx;
}

function buildOutcomesDb(opts: OutcomesDbOptions) {
  const tx = buildOutcomesTx(opts);
  return {
    transaction: jest.fn().mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    query: {
      organizations: { findFirst: jest.fn() },
      organizationMembers: { findFirst: jest.fn() },
    },
  };
}

const PARTIAL_PAYLOAD = {
  orgId: "org-1",
  userId: "actor-user-1",
  moduleKeys: ["hr"],
  sessionAction: "complete",
  skipReason: null,
  sendWelcome: true,
  industry: "tech",
  invitees: [
    { email: "alice@example.com", role: "MEMBER" },
    { email: "bob@example.com", role: "MEMBER" },
    { email: "carol@example.com", role: "MEMBER" },
    { email: "actor@example.com", role: "MEMBER" },
  ],
};

describe("OrgSetupService.getSetupStatus — recipient outcomes (P12)", () => {
  it("owner with PARTIAL and invitees gets per-recipient outcomes", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxCorrelationId: "corr-p12",
      outboxPayload: PARTIAL_PAYLOAD,
      receiptRows: [
        { email: "alice@example.com", invitationId: "inv-alice", outcome: "QUEUED" },
        { email: "bob@example.com", invitationId: "inv-bob", outcome: "QUEUED" },
        { email: "carol@example.com", invitationId: null, outcome: "REFUSED" },
        { email: "actor@example.com", invitationId: null, outcome: "SKIPPED_SELF" },
      ],
      invitationRows: [
        { id: "inv-alice", status: "PENDING" },
        { id: "inv-bob", status: "DECLINED" },
      ],
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.errorCode).toBe("SETUP_BACKGROUND_PARTIAL");
    expect(status.recipientOutcomes).not.toBeNull();

    const outcomes = status.recipientOutcomes ?? [];
    const alice = outcomes.find((o) => o.email === "alice@example.com");
    const bob = outcomes.find((o) => o.email === "bob@example.com");
    const carol = outcomes.find((o) => o.email === "carol@example.com");
    const actor = outcomes.find((o) => o.email === "actor@example.com");

    expect(alice?.outcome).toBe("queued");
    expect(alice?.reason).toBeNull();
    expect(bob?.outcome).toBe("failed");
    expect(bob?.reason).toBe("invitation_revoked");
    expect(carol?.outcome).toBe("failed");
    expect(carol?.reason).toBe("unknown");
    expect(actor?.outcome).toBe("skipped");
    expect(actor?.reason).toBeNull();
  });

  it("reports an undeliverable pending invitation as failed instead of queued", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [{ email: "withheld@example.com", role: "MEMBER" }],
      },
      receiptRows: [{ email: "withheld@example.com", invitationId: "inv-withheld", outcome: "DELIVERY_FAILED" }],
      invitationRows: [{ id: "inv-withheld", status: "PENDING" }],
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    expect(status.recipientOutcomes).toEqual([
      { email: "withheld@example.com", outcome: "failed", reason: "email_not_sent" },
    ]);
  });

  it("does not infer a recipient failure reason from later membership", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [{ email: "existing@example.com", role: "MEMBER" }],
      },
      receiptRows: [{ email: "existing@example.com", invitationId: null, outcome: "REFUSED" }],
      invitationRows: [],
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    const outcomes = status.recipientOutcomes ?? [];
    const existing = outcomes.find((o) => o.email === "existing@example.com");
    expect(existing?.outcome).toBe("failed");
    expect(existing?.reason).toBe("unknown");
  });

  it("owner-skip and later-role continuation: duplicate owner emails deduplicated into one skipped entry", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [
          { email: "actor@example.com", role: "MEMBER" },
          { email: "actor@example.com", role: "ORG_ADMIN" },
          { email: "teammate@example.com", role: "MEMBER" },
        ],
      },
      receiptRows: [
        { email: "actor@example.com", invitationId: null, outcome: "SKIPPED_SELF" },
        { email: "teammate@example.com", invitationId: "inv-teammate", outcome: "QUEUED" },
      ],
      invitationRows: [{ id: "inv-teammate", status: "PENDING" }],
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    const outcomes = status.recipientOutcomes ?? [];
    const actorEntries = outcomes.filter((o) => o.email === "actor@example.com");
    expect(actorEntries).toHaveLength(1);
    expect(actorEntries[0]?.outcome).toBe("skipped");

    const teammate = outcomes.find((o) => o.email === "teammate@example.com");
    expect(teammate?.outcome).toBe("queued");
  });

  it("outcome fields are restricted to email, outcome and reason — no raw error leaks", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [{ email: "target@example.com", role: "MEMBER" }],
      },
      receiptRows: [{ email: "target@example.com", invitationId: null, outcome: "REFUSED" }],
      invitationRows: [],
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    const outcomes = status.recipientOutcomes ?? [];
    for (const outcome of outcomes) {
      expect(Object.keys(outcome).sort()).toEqual(["email", "outcome", "reason"].sort());
    }
  });

  it("ACCEPTED invitation reports successful outcome", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [{ email: "accepted@example.com", role: "MEMBER" }],
      },
      receiptRows: [{ email: "accepted@example.com", invitationId: "inv-accepted", outcome: "QUEUED" }],
      invitationRows: [{ id: "inv-accepted", status: "ACCEPTED" }],
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    const outcomes = status.recipientOutcomes ?? [];
    const accepted = outcomes.find((o) => o.email === "accepted@example.com");
    expect(accepted?.outcome).toBe("successful");
    expect(accepted?.reason).toBeNull();
  });

  it("deduplicates a repeated payload email in status while preserving the pending invitation outcome", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [
          { email: "queued@example.com", role: "MEMBER" },
          { email: "queued@example.com", role: "ORG_ADMIN" },
        ],
      },
      receiptRows: [{ email: "queued@example.com", invitationId: "inv-queued", outcome: "QUEUED" }],
      invitationRows: [{ id: "inv-queued", status: "PENDING" }],
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(ownerActor());

    const outcomes = status.recipientOutcomes ?? [];
    const queued = outcomes.filter((o) => o.email === "queued@example.com");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.outcome).toBe("queued");
  });

  it("does not substitute an older pending invitation for a failed current setup attempt", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [{ email: "returning@example.com", role: "MEMBER" }],
      },
      receiptRows: [{ email: "returning@example.com", invitationId: null, outcome: "REFUSED" }],
      invitationRows: [{ id: "old-pending-invitation", status: "PENDING" }],
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });

    const status = await svc.getSetupStatus(ownerActor());

    expect(status.recipientOutcomes).toEqual([
      { email: "returning@example.com", outcome: "failed", reason: "unknown" },
    ]);
  });

  it("returns unknown recipient provenance for a legacy setup event with no receipts", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [{ email: "legacy@example.com", role: "MEMBER" }],
      },
      receiptRows: [],
      invitationRows: [{ id: "old-pending-invitation", status: "PENDING" }],
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });

    const status = await svc.getSetupStatus(ownerActor());

    expect(status.errorCode).toBe("SETUP_BACKGROUND_PARTIAL");
    expect(status.recipientOutcomes).toBeNull();
  });

  it("withholds recipient addresses when the current membership is no longer an owner", async () => {
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [{ email: "private@example.com", role: "MEMBER" }],
      },
      receiptRows: [{ email: "private@example.com", invitationId: null, outcome: "REFUSED" }],
      invitationRows: [],
    });
    const svc = await buildStatusService(db, { orgId: "org-1", isOwner: false });

    const status = await svc.getSetupStatus(ownerActor());

    expect(status.recipientOutcomes).toBeNull();
  });

  it("reads inbox and recipient receipts for the exact latest setup event", async () => {
    const predicates = new Map<number, SQL>();
    const db = buildOutcomesDb({
      onboardingCompletedAt: STAMP,
      hasSubscription: true,
      hasEnabledModule: true,
      inboxStatus: "COMPLETED",
      inboxHasOptionalFailure: true,
      outboxDeliveryState: "DELIVERED",
      outboxPayload: {
        ...PARTIAL_PAYLOAD,
        invitees: [{ email: "current@example.com", role: "MEMBER" }],
      },
      receiptRows: [{ email: "current@example.com", invitationId: null, outcome: "REFUSED" }],
      invitationRows: [],
      captureWhere: (selection, predicate) => predicates.set(selection, predicate),
    });
    const svc = await buildStatusService(db, { orgId: "org-1" });

    await svc.getSetupStatus(ownerActor());

    const dialect = new PgDialect();
    for (const selection of [5, 6]) {
      const predicate = predicates.get(selection);
      expect(predicate).toBeDefined();
      const query = dialect.sqlToQuery(predicate!);
      expect(query.params).toContain("org-1");
      expect(query.params).toContain("setup-event-1");
    }
  });
});

describe("OutboxWakeSignal — direct unit", () => {
  it("wake() is a no-op when no listener is registered", () => {
    const signal = new OutboxWakeSignal();
    expect(() => signal.wake()).not.toThrow();
  });

  it("wake() invokes a registered listener", () => {
    const signal = new OutboxWakeSignal();
    const listener = jest.fn();
    signal.register(listener);
    signal.wake();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("wake() swallows a synchronously throwing listener", () => {
    const signal = new OutboxWakeSignal();
    signal.register(() => {
      throw new Error("boom");
    });
    expect(() => signal.wake()).not.toThrow();
  });
});
