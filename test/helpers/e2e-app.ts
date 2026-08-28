import { AsyncLocalStorage } from "node:async_hooks";
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
import type { DataScope } from "src/modules/access/access.types";
import { moduleAvailabilityResolver } from "src/common/rbac/module-availability";
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
  resolve: async (): Promise<{ active: boolean; isOwner: boolean; role: string }> => {
    const fixture = current();
    return { active: true, isOwner: fixture.isOrgOwner, role: fixture.role };
  },
};

const entitlementsStub = {
  isModuleEnabled: async (_orgId: string, moduleKey: string): Promise<boolean> =>
    current().enabledModules.includes(moduleKey.toLowerCase()),
  getModuleMap: async (): Promise<Record<string, boolean>> =>
    Object.fromEntries(current().enabledModules.map((key) => [key, true])),
  getEffectiveModuleMap: async (): Promise<Record<string, boolean>> =>
    Object.fromEntries(current().enabledModules.map((key) => [key, true])),
  // `ModuleGuard` resolves availability from four sources, not one. The three
  // below are pinned to the identity answer so a module's availability is still
  // decided by the token's `enabledModules` alone, which is what every existing
  // spec was written against.
  isCoreModule: (): boolean => false,
  getPlanLockedModules: async (): Promise<readonly string[]> => [],
};

const accessStub = {
  resolveUserPermissions: async (): Promise<Map<string, DataScope>> =>
    new Map(current().permissions.map((key) => [key, "all" as DataScope])),
  isModuleEnabled: entitlementsStub.isModuleEnabled,
  getUserDeniedModules: async (): Promise<ReadonlySet<string>> => new Set<string>(),
  // Keep the E2E fixture on AccessService's canonical resolver surface. The
  // calendar source registry and PermissionGuard both consume these methods;
  // resolving them from the token preserves the fixture's existing semantics.
  getModuleState: async (_orgId: string, moduleKey: string): Promise<boolean | undefined> =>
    current().enabledModules.includes(moduleKey.toLowerCase()) ? true : undefined,
  scopeFor: async (_user: unknown, permissionKey: string): Promise<DataScope> =>
    current().permissions.includes(permissionKey) ? "all" : "none",
  holds: async (_user: unknown, permissionKey: string): Promise<boolean> =>
    current().permissions.includes(permissionKey),
  moduleAvailability: async (_user: unknown, moduleKey: string) =>
    current().enabledModules.includes(moduleKey.toLowerCase())
      ? { available: true as const }
      : { available: false as const, reason: "org-disabled" as const },
  moduleAvailabilityFor: async (
    _orgId: string,
    _userId: string,
    moduleKey: string,
  ) =>
    current().enabledModules.includes(moduleKey.toLowerCase())
      ? { available: true as const }
      : { available: false as const, reason: "org-disabled" as const },
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
}

export async function createE2eApp(options: E2eAppOptions = {}): Promise<INestApplication> {
  process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
  process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

  let builder: TestingModuleBuilder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MembershipStateService)
    .useValue(membershipStub)
    .overrideProvider(EntitlementsService)
    .useValue(entitlementsStub)
    .overrideProvider(AccessService)
    .useValue(accessStub);

  for (const override of options.overrides ?? [])
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);

  const ref = await builder.compile();
  installFixtureRegionRegistry(ref.get<Db>(DRIZZLE));
  const app = ref.createNestApplication();
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
