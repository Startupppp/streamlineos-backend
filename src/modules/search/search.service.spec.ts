import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { AccessResolver } from "../access/authorize";
import type { DataScope } from "../access/access.types";
import { moduleAvailabilityResolver } from "../../common/rbac/module-availability";
import { isCoreModuleKey } from "../access/entitlements.service";
import { resolveSearchAccess } from "./search-scope";
import { SearchService } from "./search.service";
import type { AccessService } from "../access/access.service";
import type { CacheService } from "../../common/cache/cache.service";
import type { Db } from "../../db/drizzle.module";

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

describe("resolveSearchAccess", () => {
  it("returns only permitted domain scopes", async () => {
    const scopes = new Map<string, DataScope>([
      ["crm:leads:view", "own"],
      ["crm:contacts:view", "team"],
      ["build:tickets:view", "all"],
    ]);
    const access: AccessResolver = {
      scopeFor: async (_user, key) => scopes.get(key) ?? "none",
      getModuleState: async (_orgId, moduleKey) =>
        moduleKey === "crm" ? true : false,
      buildModuleAvailabilityResolver: (getModuleMap) =>
        moduleAvailabilityResolver({
          isCoreModule: isCoreModuleKey,
          getModuleMap,
          getPlanLockedModules: async () => [],
        }),
    };

    const result = await resolveSearchAccess(access, user);
    expect(result.leads?.rawScope("spec reads the resolved value")).toBe("own");
    expect(result.deals).toBeNull();
    expect(result.contacts?.rawScope("spec reads the resolved value")).toBe("team");
    expect(result.clients).toBeNull();
    expect(result.build).toBeNull();
  });

  it("does not expose disabled modules to an org owner", async () => {
    const access: AccessResolver = {
      scopeFor: async () => "none",
      getModuleState: async () => false,
      buildModuleAvailabilityResolver: (getModuleMap) =>
        moduleAvailabilityResolver({
          isCoreModule: isCoreModuleKey,
          getModuleMap,
          getPlanLockedModules: async () => [],
        }),
    };

    await expect(resolveSearchAccess(access, { ...user, isOrgOwner: true })).resolves.toEqual({
      leads: null,
      deals: null,
      contacts: null,
      clients: null,
      build: null,
    });
  });
});

const dialect = new PgDialect();
function compileSql(s: SQL): string {
  return dialect.sqlToQuery(s).sql;
}

/**
 * Statement-plan tests: verify which DB statements are issued for different
 * permission configurations. These pin the "no search statements for no-access"
 * and "at most one combined probe + per-kind hydration" invariants that drove
 * the 2026-09-06 reduction from 19 statements to ≤ 7.
 */
describe("SearchService — statement plan", () => {
  const ORG = "org-plan-test";
  const USER_ID = "user-plan-test";
  const planUser: CurrentUserContext = {
    userId: USER_ID,
    orgId: ORG,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "sess-plan",
    tokenScopes: null,
    principal: humanSessionPrincipal(42, false),
  };

  function makeDb(overrides?: Partial<{ executeRows: Record<string, unknown>[] }>): {
    db: Db;
    executeCalls: SQL[];
    selectCalls: SQL[];
  } {
    const executeCalls: SQL[] = [];
    const selectCalls: SQL[] = [];
    const rows = overrides?.executeRows ?? [];
    const db = {
      execute: (stmt: SQL) => {
        executeCalls.push(stmt);
        return Promise.resolve(rows);
      },
      select: () => {
        const builder = {
          from: () => builder,
          innerJoin: () => builder,
          where: (cond: SQL) => {
            selectCalls.push(cond);
            return builder;
          },
          orderBy: () => builder,
          limit: () => builder,
          then: (resolve: (v: unknown[]) => unknown) => resolve([]),
        };
        return builder;
      },
    } as unknown as Db;
    return { db, executeCalls, selectCalls };
  }

  function makeAccess(opts: {
    moduleState: Record<string, boolean>;
    scope: Record<string, DataScope>;
  }): AccessService {
    return {
      scopeFor: jest.fn(async (_u: unknown, key: string) => opts.scope[key] ?? "none"),
      getModuleState: jest.fn(async (_o: unknown, moduleKey: string) => opts.moduleState[moduleKey] ?? false),
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
      buildModuleAvailabilityResolver(getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) {
        return moduleAvailabilityResolver({
          isCoreModule: isCoreModuleKey,
          getModuleMap,
          getPlanLockedModules: async () => [],
        });
      },
    } as unknown as AccessService;
  }

  const cache = {
    cached: <T>(_key: unknown, factory: () => Promise<T>) => factory(),
  } as unknown as CacheService;

  it("caller with no permissions issues 0 combined-probe or hydration statements", async () => {
    const { db, executeCalls, selectCalls } = makeDb();
    const access = makeAccess({ moduleState: {}, scope: {} });
    const service = new SearchService(db, cache, access);

    await service.search(planUser, "hello", 5);

    expect(executeCalls).toHaveLength(0);
    expect(selectCalls).toHaveLength(0);
  });

  it("caller with two readable kinds issues ONE combined probe + at most two hydrations", async () => {
    const { db, executeCalls, selectCalls } = makeDb({
      executeRows: [
        { kind: "lead", id: "abc-lead-1" },
        { kind: "deal", id: "1" },
      ],
    });
    const access = makeAccess({
      moduleState: { crm: true },
      scope: { "crm:leads:view": "all", "crm:deals:read": "all" },
    });
    const service = new SearchService(db, cache, access);

    await service.search(planUser, "hello", 5);

    expect(executeCalls).toHaveLength(1);
    const combinedSql = compileSql(executeCalls[0]!);
    expect(combinedSql).toContain("search_lead_party_ids");
    expect(combinedSql).toContain("search_deal_ids");
    expect(combinedSql).not.toContain("search_ticket_ids");

    expect(selectCalls.length).toBeLessThanOrEqual(2);
  });

  it("a kind with zero probe ids generates no hydration statement", async () => {
    const { db, executeCalls, selectCalls } = makeDb({
      executeRows: [{ kind: "lead", id: "abc-lead-1" }],
    });
    const access = makeAccess({
      moduleState: { crm: true },
      scope: { "crm:leads:view": "all", "crm:deals:read": "all" },
    });
    const service = new SearchService(db, cache, access);

    await service.search(planUser, "hello", 5);

    expect(executeCalls).toHaveLength(1);
    expect(selectCalls).toHaveLength(1);
  });
});
