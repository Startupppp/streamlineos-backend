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

jest.mock("../../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
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

function buildSelectChain(resolvedValue: unknown[]) {
  const limit = jest.fn().mockResolvedValue(resolvedValue);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ limit, orderBy });
  const innerJoin = jest.fn().mockReturnValue({ where, limit, orderBy });
  const from = jest.fn().mockReturnValue({ where, limit, orderBy, innerJoin });
  return { from };
}

// Index order mirrors the Promise.all in getSetupStatus: org stamp, ACTIVE owner,
// latest entitlement, enabled catalog module, inbox record, outbox event.
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
          opts.inboxStatus !== null
            ? [
                {
                  status: opts.inboxStatus,
                  hasOptionalFailure: opts.inboxHasOptionalFailure ?? false,
                },
              ]
            : [],
        );
      }
      if (idx === 5) {
        return buildSelectChain(
          opts.outboxDeliveryState !== null
            ? [{ deliveryState: opts.outboxDeliveryState, correlationId: opts.outboxCorrelationId ?? null }]
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
  resolverTarget: { orgId: string } | null,
) {
  const resolverMock = {
    resolveCurrentSetupTarget: jest.fn().mockResolvedValue(resolverTarget),
    resolveExistingSetupTarget: jest.fn().mockReturnValue(resolverTarget),
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
    const svc = await buildStatusService(db, { orgId: "org-1" });
    const status = await svc.getSetupStatus(memberActor());

    expect(status.ready).toBe(true);
    expect(Object.keys(status).sort()).toEqual([
      "correlationId",
      "errorCode",
      "onboardingCompletedAt",
      "ready",
      "orgId",
      "provisioning",
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
