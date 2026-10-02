import { Test } from "@nestjs/testing";
import { OrgSetupService } from "../org-setup.service";
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
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";

jest.mock("../../../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../rbac/seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue(undefined),
}));

const CATALOG_ROWS = [
  { moduleKey: "hr", isCore: false },
  { moduleKey: "kb", isCore: true },
];

function ownerActor(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

/**
 * Walks a Drizzle condition for an `is null` fragment. Without this the double would gate on
 * its own call order and pass even for an UPDATE that dropped the `onboarding_completed_at IS
 * NULL` predicate — the race the test exists to cover.
 */
function conditionMentionsIsNull(condition: unknown, depth = 0): boolean {
  if (depth > 8 || condition === null || typeof condition !== "object") return false;
  const chunks: unknown = Reflect.get(condition, "queryChunks");
  if (!Array.isArray(chunks)) return false;
  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) continue;
    const value: unknown = Reflect.get(chunk, "value");
    if (
      Array.isArray(value) &&
      value.some((part) => typeof part === "string" && part.includes("is null"))
    )
      return true;
    if (conditionMentionsIsNull(chunk, depth + 1)) return true;
  }
  return false;
}

/**
 * Models the one invariant two concurrent submissions rely on: the stamp is claimed by a
 * conditional UPDATE, so exactly one caller sees a returned row however many race in.
 */
function buildRacingDb() {
  const state = { stamped: false };
  const emittedEvents: Record<string, unknown>[] = [];
  const mintedTokens: Record<string, unknown>[] = [];
  const ownerWrites: Record<string, unknown>[] = [];

  function makeTx() {
    let claimIsConditional = false;
    const claimReturning = jest.fn().mockImplementation(async () => {
      if (!claimIsConditional) {
        state.stamped = true;
        return [{ id: "org-1" }];
      }
      if (state.stamped) return [];
      state.stamped = true;
      return [{ id: "org-1" }];
    });
    const whereUpdate = jest.fn().mockImplementation((condition: unknown) => {
      claimIsConditional = conditionMentionsIsNull(condition);
      return {
        returning: claimReturning,
        then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
      };
    });
    const set = jest.fn().mockImplementation((values: Record<string, unknown>) => {
      if ("lastActiveOrgId" in values) ownerWrites.push(values);
      return { where: whereUpdate };
    });
    const update = jest.fn().mockReturnValue({ set });

    const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    const returning = jest.fn().mockResolvedValue([]);
    const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockImplementation((row: unknown) => {
      if (Array.isArray(row)) return { onConflictDoUpdate, onConflictDoNothing };
      const record: Record<string, unknown> =
        typeof row === "object" && row !== null
          ? (row as Record<string, unknown>)
          : {};
      if ("tokenHash" in record) mintedTokens.push(record);
      if ("eventType" in record) emittedEvents.push(record);
      return {
        onConflictDoUpdate,
        onConflictDoNothing,
        then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
      };
    });
    const insert = jest.fn().mockReturnValue({ values });

    const limit = jest.fn().mockResolvedValue([{ ownerMembershipId: 99 }]);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({
      where,
      then: (resolve: (rows: typeof CATALOG_ROWS) => unknown) => resolve(CATALOG_ROWS),
    });
    const select = jest.fn().mockReturnValue({ from });

    return {
      execute: jest.fn().mockResolvedValue(undefined),
      insert,
      update,
      select,
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ id: "org-1", name: "Acme" }),
        },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ status: "ACTIVE", isOwner: true }),
        },
      },
    };
  }

  const db = {
    query: makeTx().query,
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (t: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx()),
      ),
  };

  return { db, state, emittedEvents, mintedTokens, ownerWrites };
}

async function buildService(db: unknown) {
  const wake = jest.fn();
  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgSetupService,
      OrgSetupResolverService,
      { provide: OrganizationCreationService, useValue: { createFromSetup: jest.fn() } },
      {
        provide: AccountOrganizationIndexService,
        useValue: {
          activate: jest.fn().mockResolvedValue({ status: "activated" }),
          refreshForUser: jest.fn(),
        },
      },
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: CacheService, useValue: { invalidate: jest.fn() } },
      {
        provide: OnboardingSessionService,
        useValue: {
          getOrCreateSession: jest.fn().mockResolvedValue({ id: 42 }),
          skipSession: jest.fn().mockResolvedValue(undefined),
          completeSession: jest.fn().mockResolvedValue(undefined),
        },
      },
      {
        provide: ModuleChecklistService,
        useValue: { ensureChecklistsForModules: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: NotificationDispatchService, useValue: { emit: jest.fn() } },
      { provide: OutboxWakeSignal, useValue: { wake, register: jest.fn() } },
      {
        provide: PlanLimitsService,
        useValue: {
          resolveTierFreshInTransaction: jest.fn().mockResolvedValue({ tier: "PAID", plan: "STARTER" }),
        },
      },
    ],
  }).compile();
  return { svc: moduleRef.get(OrgSetupService), wake };
}

const SETUP_INPUT = {
  industry: "IT Services",
  companySize: "1-10",
  enabledModules: ["hr"],
} as Parameters<OrgSetupService["completeSetup"]>[1];

function tokenCount(results: Array<{ autoLoginToken?: string }>): number {
  return results.filter((result) => result.autoLoginToken !== undefined).length;
}

describe("OrgSetupService — two concurrent submissions produce one logical setup (OS-R5)", () => {
  it("two parallel completeSetup calls: one stamp, one token, one event, same orgId", async () => {
    const { db, emittedEvents, mintedTokens } = buildRacingDb();
    const { svc, wake } = await buildService(db);

    const results = await Promise.all([
      svc.completeSetup(ownerActor(), SETUP_INPUT),
      svc.completeSetup(ownerActor(), SETUP_INPUT),
    ]);

    expect(results.map((result) => result.orgId)).toEqual(["org-1", "org-1"]);
    expect(tokenCount(results)).toBe(1);
    expect(mintedTokens).toHaveLength(1);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      eventType: "organization.setup.completed",
      organizationId: "org-1",
    });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("two parallel skipSetup calls: one stamp, one token, one event", async () => {
    const { db, emittedEvents, mintedTokens } = buildRacingDb();
    const { svc, wake } = await buildService(db);

    const results = await Promise.all([
      svc.skipSetup(ownerActor()),
      svc.skipSetup(ownerActor()),
    ]);

    expect(tokenCount(results)).toBe(1);
    expect(mintedTokens).toHaveLength(1);
    expect(emittedEvents).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("a complete racing a skip still yields exactly one event, and it is the winner's action", async () => {
    const { db, emittedEvents } = buildRacingDb();
    const { svc } = await buildService(db);

    await Promise.all([
      svc.completeSetup(ownerActor(), SETUP_INPUT),
      svc.skipSetup(ownerActor()),
    ]);

    expect(emittedEvents).toHaveLength(1);
    const payload = emittedEvents[0]?.["payload"];
    expect(payload).toMatchObject({ orgId: "org-1", userId: "user-1" });
  });

  it("the loser of the race still gets a truthful success for the same organization", async () => {
    const { db } = buildRacingDb();
    const { svc } = await buildService(db);

    const [first, second] = await Promise.all([
      svc.completeSetup(ownerActor(), SETUP_INPUT),
      svc.completeSetup(ownerActor(), SETUP_INPUT),
    ]);

    expect(first).toMatchObject({ success: true, orgId: "org-1" });
    expect(second).toMatchObject({ success: true, orgId: "org-1" });
  });

  it("a reload that replays the submission after the stamp was claimed mints no second token", async () => {
    const { db, mintedTokens } = buildRacingDb();
    const { svc } = await buildService(db);

    await svc.completeSetup(ownerActor(), SETUP_INPUT);
    const replay = await svc.completeSetup(ownerActor(), SETUP_INPUT);

    expect(replay).toEqual({ success: true, orgId: "org-1" });
    expect(mintedTokens).toHaveLength(1);
  });
});
