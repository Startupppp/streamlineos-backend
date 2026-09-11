import { AsyncLocalStorage } from "node:async_hooks";
import { seedOrg } from "./e2e-seed";
import type { INestApplication } from "@nestjs/common";
import { VERSION_NEUTRAL, VersioningType } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import { decodeJwt } from "jose";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "src/app.module";
import { AllExceptionsFilter } from "src/common/http/all-exceptions.filter";
import { MembershipStateService } from "src/common/auth/membership-state.service";
import { EntitlementsService } from "src/modules/access/entitlements.service";
import { AccessService } from "src/modules/access/access.service";
import { MfaPolicyService } from "src/modules/access/mfa-policy.service";
import type { DataScope } from "src/modules/access/access.types";
import { moduleAvailabilityResolver } from "src/common/rbac/module-availability";
import { isCoreModuleKey, moduleDefinition, moduleIdFromStored } from "src/common/rbac/module-registry";
import { ADMINISTRABLE_MODULES } from "src/common/rbac/module-vocabulary";
import { RegionRegistry, setRegionRegistry } from "src/common/region/region-registry";
import {
  DEFAULT_DATABASE_SHARD,
  DEFAULT_SEARCH_CLUSTER,
  LEGACY_CELL_ID,
} from "src/common/region/placement";
import type { RegionDefinition } from "src/common/region/region.config";
import type { Db } from "src/db/drizzle.types";
import { DRIZZLE } from "src/db/drizzle.constants";
import { API_VERSION_CURRENT } from "src/common/http/api-version";
import { COMMAND_FENCE_STORE } from "src/common/idempotency/command-fence-store";
import { InMemoryCommandFenceStore } from "src/common/idempotency/command-fence-store-memory";
import { PayrollJobsWorkerService } from "src/modules/payroll/jobs/payroll-jobs-worker.service";
import { PayrollCalendarReminderScheduler } from "src/modules/payroll/insights/payroll-calendar-reminder.scheduler";
import { NotificationDeliveryWorker } from "src/modules/notifications/notification-delivery-worker.service";
import { PermissionCatalogSyncService } from "src/modules/rbac/permission-catalog-sync.service";

/**
 * Controller e2e specs assert the guard chain — 401 / 402 / 403 — and every one
 * of those is thrown before the handler, so none of them needs a database.
 * What they do need is the three services the guards consult:
 * `MembershipStateService` (JwtAuthGuard), `EntitlementsService` (ModuleGuard)
 * and `AccessService` (PermissionGuard). Left real, each one reads Postgres for
 * a fixture nobody seeded and the request 401s before the assertion under test
 * is ever reached.
 *
 * The claims a spec passes to `signToken` — permissions, enabledModules,
 * isOrgOwner — are ignored by the real guards, which resolve from the database
 * instead. Here they are the fixture: a middleware decodes the request's bearer
 * token into async-local storage and the overridden services answer from it, so
 * one application serves every case in a suite without a per-test rebuild.
 */
interface E2eFixture {
  permissions: readonly string[];
  enabledModules: readonly string[];
  isOrgOwner: boolean;
  role: string;
}

const EMPTY: E2eFixture = {
  permissions: [],
  enabledModules: [],
  isOrgOwner: false,
  role: "MEMBER",
};

const storage = new AsyncLocalStorage<E2eFixture>();

function current(): E2eFixture {
  return storage.getStore() ?? EMPTY;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function fixtureFromToken(header: string | undefined): E2eFixture {
  if (!header?.startsWith("Bearer ")) return EMPTY;
  try {
    const claims = decodeJwt(header.slice("Bearer ".length).trim());
    return {
      permissions: stringArray(claims["permissions"]),
      enabledModules: stringArray(claims["enabledModules"]).map((m) => m.toLowerCase()),
      isOrgOwner: claims["isOrgOwner"] === true,
      role: typeof claims["role"] === "string" ? claims["role"] : "MEMBER",
    };
  } catch {
    return EMPTY;
  }
}

const membershipStub = {
  isAccountActive: async (): Promise<boolean> => true,
  resolve: async (): Promise<{ active: boolean; isOwner: boolean; role: string; membershipId: number | null }> => {
    const fixture = current();
    return { active: true, isOwner: fixture.isOrgOwner, role: fixture.role, membershipId: 1 };
  },
};

/**
 * MFA policy: no org enforces MFA in the e2e harness. Without this stub the
 * MfaGuard queries a local DB that has no `users` table, catches the error and
 * returns the safe-fail `UNDETERMINED` state (`enforced: true, satisfied: false`),
 * which throws MFA_REQUIRED 403 BEFORE PermissionGuard can answer — every
 * permission-tier test reports the wrong status code.
 */
const mfaPolicyStub = {
  resolve: async (): Promise<{ enforced: boolean; satisfied: boolean }> =>
    ({ enforced: false, satisfied: true }),
  invalidateOrg: async (): Promise<void> => undefined,
  invalidateUser: async (): Promise<void> => undefined,
};

function fixtureModuleAvailable(moduleKey: string): boolean {
  return (
    isCoreModuleKey(moduleKey) ||
    current().enabledModules.includes(moduleKey.toLowerCase())
  );
}

const entitlementsStub = {
  isModuleEnabled: async (_orgId: string, moduleKey: string): Promise<boolean> =>
    fixtureModuleAvailable(moduleKey),
  getModuleMap: async (): Promise<Record<string, boolean>> =>
    Object.fromEntries(current().enabledModules.map((key) => [key, true])),
  getEffectiveModuleMap: async (): Promise<Record<string, boolean>> =>
    Object.fromEntries(current().enabledModules.map((key) => [key, true])),
  // `ModuleGuard` resolves availability from four sources, not one. The three
  // below are pinned to the identity answer so a module's availability is still
  // decided by the token's `enabledModules` alone, which is what every existing
  // spec was written against.
  isCoreModule: isCoreModuleKey,
  getPlanLockedModules: async (): Promise<readonly string[]> => [],
  /**
   * Derived from the two answers above rather than given its own.
   *
   * `GET /entitlements/modules` calls this, and without it the route threw
   * "listModules is not a function" and answered 500. Building the list from
   * `isCoreModule` and the token's `enabledModules` keeps it from becoming a
   * third source of truth for "is this module on" that can drift from the two
   * the guards ask.
   */
  listModules: async (): Promise<
    { moduleKey: string; enabled: boolean; core?: true }[]
  > => {
    const enabled = current().enabledModules;
    return ADMINISTRABLE_MODULES.map((moduleKey) =>
      moduleDefinition(moduleIdFromStored(moduleKey)) === undefined
        ? { moduleKey, enabled: true, core: true as const }
        : { moduleKey, enabled: enabled.includes(moduleKey.toLowerCase()) },
    );
  },
};

/** `CurrentUserContext.isOrgOwner`, as the guard chain populates it. */
function isOwnerContext(user: unknown): boolean {
  return (
    typeof user === "object" && user !== null && (user as { isOrgOwner?: unknown }).isOrgOwner === true
  );
}

export const accessStub = {
  resolveUserPermissions: async (): Promise<Map<string, DataScope>> =>
    new Map(current().permissions.map((key) => [key, "all" as DataScope])),
  isModuleEnabled: entitlementsStub.isModuleEnabled,
  getUserDeniedModules: async (): Promise<ReadonlySet<string>> => new Set<string>(),
  /**
   * Nobody but the caller, because a token-driven fixture has no other members.
   *
   * The real method reads `organization_members` inside a tenant transaction to
   * find everyone holding a key — a question this fixture has no seeded data to
   * answer. Its absence, though, was not a missing answer but a 500: the client
   * accounts service calls it while assigning support ownership, and threw
   * "membersWithPermission is not a function" mid-request. An empty list is the
   * honest reading of an org whose only member is the token.
   */
  membersWithPermission: async (): Promise<
    { userId: string; membershipId: number }[]
  > => [],
  /**
   * The version the real service bumps when an org's permissions change.
   *
   * Its absence was not silently harmless: `SearchService.search` calls it on
   * every query, so `/search` threw "getPermissionsVersion is not a function"
   * and answered 500 — under a suite whose cases only assert 401 and 403, which
   * is why the whole thing stayed green while the endpoint was broken.
   *
   * It is derived from the current permission set rather than pinned to a
   * constant because search folds this number into its cache key precisely so a
   * permission change invalidates it. A constant would let one case's results
   * answer the next case's identical query under a different set of grants.
   */
  getPermissionsVersion: async (): Promise<number> => {
    const keys = [...current().permissions].sort().join("|");
    let hash = 0;
    for (let i = 0; i < keys.length; i += 1) hash = (hash * 31 + keys.charCodeAt(i)) | 0;
    return Math.abs(hash);
  },
  // Keep the E2E fixture on AccessService's canonical resolver surface. The
  // calendar source registry and PermissionGuard both consume these methods;
  // resolving them from the token preserves the fixture's existing semantics.
  // Core modules first, as `EntitlementsService.getModuleState` answers them:
  // a platform surface with no org toggle is on however the org is configured.
  getModuleState: async (_orgId: string, moduleKey: string): Promise<boolean | undefined> => {
    return fixtureModuleAvailable(moduleKey) ? true : undefined;
  },
  // The owner bypass first, exactly as `AccessService.scopeFor` does it: an org
  // owner holds everything and never consults the permission map. Without this
  // the fixture refused owners, so a case asserting "200 for org owner" got 403.
  // Both readings of owner count: the context the guard chain populated, and the
  // claim the fixture token was minted with.
  scopeFor: async (user: unknown, permissionKey: string): Promise<DataScope> =>
    isOwnerContext(user) || current().isOrgOwner || current().permissions.includes(permissionKey)
      ? "all"
      : "none",
  holds: async (user: unknown, permissionKey: string): Promise<boolean> =>
    isOwnerContext(user) || current().isOrgOwner || current().permissions.includes(permissionKey),
  moduleAvailability: async (_user: unknown, moduleKey: string) => {
    return fixtureModuleAvailable(moduleKey)
      ? { available: true as const }
      : { available: false as const, reason: "org-disabled" as const };
  },
  moduleAvailabilityFor: async (
    _orgId: string,
    _userId: string,
    moduleKey: string,
  ) => {
    return fixtureModuleAvailable(moduleKey)
      ? { available: true as const }
      : { available: false as const, reason: "org-disabled" as const };
  },
  buildModuleAvailabilityResolver: (
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
  ) =>
    moduleAvailabilityResolver(
      {
        isCoreModule: entitlementsStub.isCoreModule,
        getModuleMap,
        getPlanLockedModules: entitlementsStub.getPlanLockedModules,
      },
      {
        getUserDeniedModules: async () => new Set<string>(),
      },
    ),
};

/**
 * Places the fixture organisation.
 *
 * `signToken` mints tokens for `org_1`, which is not a row in `organizations` —
 * so `regionForOrg` correctly fails closed and every request that reaches a
 * handler dies with an unmapped 500 before the handler runs. Guards run before
 * interceptors, so the 401/403 suites never noticed; only a test asserting a
 * decision made *inside* a handler did.
 *
 * Stubbing the placement is the same move the harness already makes for
 * membership, entitlements and access: production keeps failing closed for an
 * unplaced tenant, which is the behaviour ticket 03 exists to guarantee.
 */
export function installFixtureRegionRegistry(db: Db): void {
  const definition: RegionDefinition = {
    key: "primary",
    databaseUrl: process.env.DATABASE_URL ?? "",
    cell: {
      cellId: LEGACY_CELL_ID,
      databaseShard: DEFAULT_DATABASE_SHARD,
      searchCluster: DEFAULT_SEARCH_CLUSTER,
      acceptedTenantClasses: ["SHARED"],
      complianceZones: [],
      cache: {},
    },
    storage: {
      region: "auto",
      bucket: "fixture",
      accessKeyId: undefined,
      secretAccessKey: undefined,
      endpoint: undefined,
    } as RegionDefinition["storage"],
  };

  setRegionRegistry(
    new RegionRegistry(
      { primary: "primary", regions: { primary: definition } },
      new Map([["primary", { definition, db }]]),
      async () => "primary",
    ),
  );
}

export interface E2eAppOptions {
  /** Extra provider overrides — services the controller under test injects. */
  overrides?: ReadonlyArray<{ provide: unknown; useValue: unknown }>;
  /**
   * Keep the received bytes on the request, as `main.ts` does.
   *
   * Off by default because it costs a copy of every body, and because a suite
   * asserting the guard chain has no use for it. On for the one thing that
   * cannot be tested without it: a handler that verifies an HMAC.
   *
   * A signature covers the bytes the sender sent. Re-serialising a parsed
   * object changes key order and whitespace and produces a different digest, so
   * a handler that signed `JSON.stringify(req.body)` rejects every genuine
   * delivery — and passes every test built on its own serialisation. Without
   * this flag the harness has no `rawBody` at all, so such a handler reads the
   * empty string and refuses everything, which is a green suite for a broken
   * endpoint in the other direction.
   */
  rawBody?: boolean;
}

/**
 * The three the harness owns, and the stub each one layers onto.
 *
 * A spec that overrides one of these means "the same guard chain, but with these
 * permissions" — it is not trying to remove `moduleAvailability` or `holds`. But
 * `useValue` replaces wholesale, so a two-method mock like
 *
 *     { resolveUserPermissions: jest.fn(), isModuleEnabled: jest.fn() }
 *
 * left `ModuleGuard` calling `accessSvc.moduleAvailability` on an object that
 * has not got one. That is a `TypeError` inside a guard, which
 * `AllExceptionsFilter` turns into a 500 — so a suite asserting 403 sees 500,
 * and a suite asserting 200 sees 500, and neither says why.
 *
 * It is a slow trap rather than a mistake anyone made once: every method added
 * to `AccessService` for the guards breaks every spec that hand-rolled a partial
 * mock, at a distance, in a suite nobody was editing. Merging means the spec's
 * own answers win and everything it did not mention still works.
 */
/** The organisation `signToken` mints for by default. */
const FIXTURE_ORG_ID = "org_1";

const HARNESS_STUBS = new Map<unknown, object>([
  [MembershipStateService, membershipStub],
  [EntitlementsService, entitlementsStub],
  [AccessService, accessStub],
]);

/**
 * A spec that answered the old question has answered the new one too.
 *
 * The guard chain was refactored underneath these fixtures. `ModuleGuard` used
 * to ask `isModuleEnabled` and now asks `moduleAvailability`, which carries a
 * reason as well as a verdict; `authorize` used to read the whole permission map
 * and now asks `scopeFor` for one key. Eight specs still mock only the old
 * names.
 *
 * Nothing warns. The old mock becomes inert, the guard falls through to the
 * token — which those specs deliberately leave empty, because they were
 * expressing permissions and module state through the mock instead — and the
 * case asserting 200 gets a 402 or a 403 with nothing to say why.
 *
 * Derived rather than left to each spec, for the same reason `entitlementsStub`
 * pins its three sources to one answer above: "is this module on" and "does this
 * user hold this key" are each one question, and a fixture that can answer one
 * of them twice differently is a fixture that eventually will. A spec that wants
 * something the old name cannot express — a specific unavailability *reason*, or
 * a scope of `team` rather than `all` — overrides the new name directly, and
 * that still wins.
 */
function layerOverStub(stub: object, override: Record<string, unknown>): object {
  const merged: Record<string, unknown> = withDerivedScope(stub, override) as Record<string, unknown>;

  const enabled = override["isModuleEnabled"];
  if (typeof enabled !== "function") return merged;

  const answer = enabled as (orgId: string, moduleKey: string) => Promise<boolean>;
  const verdict = async (orgId: string, moduleKey: string) =>
    (await answer(orgId, moduleKey))
      ? ({ available: true } as const)
      : ({ available: false, reason: "org-disabled" } as const);

  if (!("moduleAvailability" in override))
    merged["moduleAvailability"] = (_user: unknown, moduleKey: string) =>
      verdict("", moduleKey);
  if (!("moduleAvailabilityFor" in override))
    merged["moduleAvailabilityFor"] = (orgId: string, _userId: string, moduleKey: string) =>
      verdict(orgId, moduleKey);
  if (!("getModuleState" in override))
    merged["getModuleState"] = async (orgId: string, moduleKey: string) =>
      (await answer(orgId, moduleKey)) ? true : undefined;

  return merged;
}

/** The permission half of the same story: `resolveUserPermissions` → `scopeFor`. */
function withDerivedScope(stub: object, override: Record<string, unknown>): object {
  const merged: Record<string, unknown> = { ...stub, ...override };

  const resolve = override["resolveUserPermissions"];
  if (typeof resolve !== "function") return merged;

  const map = resolve as (orgId: string, userId: string) => Promise<Map<string, DataScope>>;

  /**
   * `AccessService.scopeFor`, reproduced: the owner bypass, then the map — and
   * the map is called `(orgId, userId)`, not with the context. A derivation that
   * got either wrong would answer "none" for an org owner, which is the one
   * caller that holds everything.
   */
  const scope = async (ctx: unknown, permissionKey: string): Promise<DataScope> => {
    if (isOwnerContext(ctx)) return "all";
    const who = (ctx ?? {}) as { orgId?: string; userId?: string };
    return (await map(who.orgId ?? "", who.userId ?? "")).get(permissionKey) ?? "none";
  };

  if (!("scopeFor" in override)) merged["scopeFor"] = scope;
  if (!("holds" in override))
    merged["holds"] = async (ctx: unknown, permissionKey: string) =>
      (await scope(ctx, permissionKey)) !== "none";

  return merged;
}

export async function createE2eApp(options: E2eAppOptions = {}): Promise<INestApplication> {
  process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
  process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
  // Admission control leaks in-flight counters when a downstream guard rejects
  // (the interceptor that releases never runs). After orgMaxConcurrent (50)
  // leaked requests for the same org, AdmissionGuard starts returning 503 for
  // every subsequent request regardless of the actual test intent. Disable it
  // here so every e2e suite starts with a clean counter state.
  process.env.ADMISSION_ENABLED = "false";
  process.env.NOTIFICATIONS_INPROCESS_WORKER = "false";
  process.env.HR_EXPORT_WORKER_ENABLED = "false";
  process.env.PAYROLL_EXPORT_WORKER_ENABLED = "false";
  process.env.EXPENSE_EXPORT_WORKER_ENABLED = "false";
  process.env.FINANCE_REPORT_EXPORT_WORKER_ENABLED = "false";
  process.env.GDPR_EXPORT_WORKER_ENABLED = "false";
  process.env.OUTBOX_INPROCESS_WORKER = "false";
  process.env.PAYROLL_JOBS_WORKER_ENABLED = "false";

  let builder: TestingModuleBuilder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MembershipStateService)
    .useValue(membershipStub)
    .overrideProvider(EntitlementsService)
    .useValue(entitlementsStub)
    .overrideProvider(AccessService)
    .useValue(accessStub)
    .overrideProvider(MfaPolicyService)
    .useValue(mfaPolicyStub)
    .overrideProvider(COMMAND_FENCE_STORE)
    .useValue(new InMemoryCommandFenceStore())
    .overrideProvider(PayrollJobsWorkerService)
    .useValue({})
    .overrideProvider(PayrollCalendarReminderScheduler)
    .useValue({})
    .overrideProvider(NotificationDeliveryWorker)
    .useValue({})
    .overrideProvider(PermissionCatalogSyncService)
    .useValue({});

  for (const override of options.overrides ?? []) {
    const stub = HARNESS_STUBS.get(override.provide);
    const value =
      stub && override.useValue && typeof override.useValue === "object"
        ? layerOverStub(stub, override.useValue as Record<string, unknown>)
        : override.useValue;
    builder = builder.overrideProvider(override.provide).useValue(value);
  }

  const ref = await builder.compile();
  installFixtureRegionRegistry(ref.get<Db>(DRIZZLE));

  /*
    The fixture organisation exists as a row, not only as a claim in a token.

    `signToken` mints tokens for `org_1`, and tenant tables carry foreign keys to
    `organizations` — `command_fences` among them. The idempotency interceptor
    writes a fence before the handler runs, so an *auth* test asserting 403 on an
    idempotent route got a 500 from a foreign key instead, and the thing it was
    checking never happened. Seeding is idempotent, so suites that seed their own
    organisations are unaffected.
  */
  const seedTarget = ref.get<Db>(DRIZZLE) as Db & {
    transaction?: unknown;
    insert?: unknown;
  };
  // Only where there is a database to seed. A spec that overrides `DRIZZLE` with
  // a double is testing something that never reaches one, and seeding against
  // the double dies on `tx.insert` before the spec starts. `insert` is the
  // discriminator rather than `transaction`, because the doubles tend to carry a
  // `transaction` that hands back a `tx` with only the two methods they need.
  if (typeof seedTarget.transaction === "function" && typeof seedTarget.insert === "function")
    await seedOrg(seedTarget, FIXTURE_ORG_ID, FIXTURE_ORG_ID);
  const app = ref.createNestApplication({ rawBody: options.rawBody === true });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: [API_VERSION_CURRENT, VERSION_NEUTRAL],
  });
  app.use((req: Request, _res: Response, next: NextFunction) =>
    storage.run(fixtureFromToken(req.headers.authorization), next),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}
