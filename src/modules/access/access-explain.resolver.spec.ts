import { getTableName, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeMembershipStateStub } from "../../../test/helpers/membership-state-stub";
import type { Db } from "../../db/drizzle.module";
import type { EntitlementsService } from "./entitlements.service";
import { AccessPermissionResolver } from "./access-permission.resolver";
import { AccessExplainResolver } from "./access-explain.resolver";
import {
  effectiveScopesOf,
  restrictExplanationTo,
  type AccessExplanation,
} from "./access-explain-provenance";
import type { DataScope } from "./access.types";
import {
  ALL_PERMISSION_NAMES,
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
  moduleScopedPermissions,
} from "../rbac/permissions";
import { EMPLOYEE_SELF_SERVICE_GRANTS } from "./access-policy";
import { isDelegablePermission } from "../../common/rbac/grantability";

/**
 * A table's rows, or a function of the bound values its predicate actually
 * carried. The second form exists for `group_role_assignments`, whose rows are
 * reachable only through the group ids the previous read returned — a static
 * array there would answer the same roles however many groups reached the
 * query, and the group-membership page boundary could never be observed.
 */
type FixtureTable = unknown[] | ((whereParams: unknown[]) => unknown[]);

type FixtureRows = Record<string, FixtureTable>;

/** The page size the drains in `access-grant-drains.ts` read at. */
const PAGE_SIZE = 500;

const dialect = new PgDialect();

function renderParams(args: unknown[]): unknown[] {
  const params: unknown[] = [];
  for (const arg of args) {
    try {
      params.push(...dialect.sqlToQuery(arg as never).params);
    } catch {
      continue;
    }
  }
  return params;
}

/**
 * A table-driven Drizzle double.
 *
 * The two resolvers under test issue the same reads in a different ORDER, so a
 * `mockReturnValueOnce` chain would answer one of them with the other's rows and
 * the parity assertion below would compare two wrong maps. Dispatching on the
 * table handed to `.from()` makes the fixture order-free.
 *
 * It HONOURS the `limit` argument and serves each table as a real page sequence,
 * which is what lets the boundary cases below bite: the truncation this parity
 * suite guards against happens in Postgres, so a double that answers every page
 * with the whole fixture loses nothing when a cap is restored and the assertion
 * passes over a defect.
 */
function makeFixtureDb(rows: FixtureRows): Db {
  const served = new Map<string, number>();
  const resolved = new Map<string, unknown[]>();

  const pageOf = (
    table: string,
    whereParams: unknown[],
    count: number,
  ): unknown[] => {
    let all = resolved.get(table);
    if (all === undefined) {
      const entry = rows[table];
      all = typeof entry === "function" ? entry(whereParams) : (entry ?? []);
      resolved.set(table, all);
    }
    const from = served.get(table) ?? 0;
    const page = all.slice(from, from + count);
    served.set(table, from + page.length);
    return page;
  };

  const select = jest.fn(() => {
    let table = "";
    const whereParams: unknown[] = [];
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(),
      where: jest.fn(),
      innerJoin: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
    };
    chain.from.mockImplementation((from: Table) => {
      table = getTableName(from);
      return chain;
    });
    chain.where.mockImplementation((...args: unknown[]) => {
      whereParams.push(...renderParams(args));
      return chain;
    });
    chain.innerJoin.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    chain.limit.mockImplementation((count?: number) =>
      Promise.resolve(
        pageOf(
          table,
          whereParams,
          typeof count === "number" ? count : PAGE_SIZE,
        ),
      ),
    );
    return chain;
  });
  return { select } as unknown as Db;
}

function makeEntitlementsStub(
  moduleMap: Record<string, boolean> = {},
): EntitlementsService {
  return {
    getModuleMap: jest.fn(async () => moduleMap),
    isCoreModule: jest.fn(
      (moduleKey: string) =>
        moduleKey === "home" ||
        moduleKey === "kb" ||
        moduleKey === "chat" ||
        moduleKey === "mail" ||
        moduleKey === "calendar",
    ),
  } as unknown as EntitlementsService;
}

function makeRealResolver(
  db: Db,
  member: { isOwner?: boolean; role?: string },
): AccessPermissionResolver {
  return new AccessPermissionResolver(
    () => db,
    (read) => Promise.resolve(read()),
    new Set<string>(),
    new Map(),
    15_000,
    async () => ({
      active: true,
      isOwner: member.isOwner ?? false,
      role: member.role ?? "MEMBER",
      membershipId: 1,
    }),
  );
}

function makeExplainResolver(
  db: Db,
  member: { isOwner?: boolean; role?: string },
  moduleMap: Record<string, boolean> = {},
): AccessExplainResolver {
  return new AccessExplainResolver(
    db,
    makeMembershipStateStub({
      active: true,
      isOwner: member.isOwner ?? false,
      role: member.role ?? "MEMBER",
      membershipId: 1,
    }),
    makeEntitlementsStub(moduleMap),
  );
}

const DELEGABLE_KEYS = ALL_PERMISSION_NAMES.filter(isDelegablePermission);
const ORG_ONLY_KEY = ALL_PERMISSION_NAMES.find(
  (key) => !isDelegablePermission(key),
);
const GRANTED_VIEW_KEY = DELEGABLE_KEYS[0] ?? "";
const GRANTED_UPDATE_KEY = DELEGABLE_KEYS[1] ?? "";
const DELEGATED_KEY = DELEGABLE_KEYS[2] ?? "";
const UNKNOWN_KEY = "ghostmodule:ghostresource:view";

const FAR_FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const NEAR_FUTURE = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

/**
 * Every grant path at once, so the parity assertion covers the whole fold:
 * a direct role with explicit grants, an expiring direct role, a role reached
 * only through a principal group, a personal grant that BROADENS a role grant,
 * an active delegation, module ownership, plus an org-only key and an unknown
 * key that both resolvers must drop.
 */
function everyGrantPathFixture(): FixtureRows {
  return {
    role_assignments: [
      { id: 1, roleId: 10, expiresAt: NEAR_FUTURE },
      { id: 2, roleId: 11, expiresAt: null },
    ],
    principal_group_members: [{ id: 1, principalGroupId: 5 }],
    group_role_assignments: [{ id: 1, roleId: 12 }],
    roles: [
      { id: 10, slug: "CRM_MODULE_ADMIN", name: "CRM administrator" },
      { id: 11, slug: "MEMBER", name: "Member" },
      { id: 12, slug: "HR_ADMIN", name: "HR administrator" },
    ],
    role_permission_grants: [
      { id: 1, roleId: 10, permissionKey: GRANTED_VIEW_KEY, scope: "own" },
      { id: 2, roleId: 10, permissionKey: GRANTED_UPDATE_KEY, scope: "team" },
      { id: 3, roleId: 10, permissionKey: UNKNOWN_KEY, scope: "all" },
      ...(ORG_ONLY_KEY
        ? [{ id: 4, roleId: 10, permissionKey: ORG_ONLY_KEY, scope: "all" }]
        : []),
    ],
    user_permission_grants: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        permissionKey: GRANTED_VIEW_KEY,
        scope: "all",
      },
    ],
    user_delegation_permissions: [
      {
        delegationId: "delegation-1",
        permissionKey: DELEGATED_KEY,
        startsAt: PAST,
        endsAt: FAR_FUTURE,
      },
    ],
    module_ownerships: [{ id: 1, moduleKey: "crm" }],
  };
}

/**
 * The four caps the explain resolver carried after the authoritative resolver
 * moved to keyset drains: 500 on role assignments, 500 on principal-group
 * memberships, 100 on module ownerships and 500 on group-role assignments. Past
 * any of them the screen showed a NARROWER set of rights than the API grants,
 * which is the one direction a provenance view must never drift in. The fixtures
 * below cross all four.
 */
const OLD_ASSIGNMENT_CAP = 500;
const OLD_OWNERSHIP_CAP = 100;
const ASSIGNMENTS_PAST_THE_CAP = 1201;
const GROUPS_PAST_THE_CAP = OLD_ASSIGNMENT_CAP + 1;

const OWNED_MODULE = "crm";
const SCOPES_NOTHING = "module-that-scopes-nothing";
const GROUP_PREFIX = "grp-";

const ALWAYS_GRANTED = new Set<string>([
  ...UNIVERSAL_MEMBER_PERMISSION_GRANTS.map((grant) => grant.permissionKey),
  ...EMPLOYEE_SELF_SERVICE_GRANTS.map((grant) => grant.permissionKey),
]);

/** Keys the admin slug's defaults are the ONLY source of, so one late role decides them. */
const ADMIN_ONLY_KEYS = (ROLE_DEFAULT_PERMISSIONS.ORG_ADMIN ?? []).filter(
  (key) => !ALWAYS_GRANTED.has(key),
);

/** Keys that arrive only by expanding the one ownership sitting past the old cap. */
const OWNED_MODULE_KEYS = moduleScopedPermissions(OWNED_MODULE)
  .filter(isDelegablePermission)
  .filter((key) => !ALWAYS_GRANTED.has(key));

/** Ids sort as text, so zero-padding keeps the keyset order the row order. */
function padded(index: number): string {
  return String(index).padStart(6, "0");
}

function roleRowsFor(
  roleIds: readonly number[],
  adminRoleId: number,
): unknown[] {
  return roleIds.map((roleId) => ({
    id: roleId,
    slug: roleId === adminRoleId ? "ORG_ADMIN" : `CUSTOM_ROLE_${roleId}`,
    name: `Role ${roleId}`,
  }));
}

/**
 * 1,201 direct role assignments and 101 module ownerships. The role carrying the
 * admin slug is the LAST assignment and the only owned module that scopes
 * anything is the LAST ownership, so restoring either cap drops precisely the
 * row that decides a permission set.
 */
function pastTheStandingCapsFixture(): FixtureRows {
  const roleIds = Array.from(
    { length: ASSIGNMENTS_PAST_THE_CAP },
    (_row, index) => index + 1,
  );
  return {
    role_assignments: roleIds.map((roleId) => ({
      id: `ra-${padded(roleId)}`,
      roleId,
      expiresAt: null,
    })),
    roles: roleRowsFor(roleIds, ASSIGNMENTS_PAST_THE_CAP),
    module_ownerships: [
      ...Array.from({ length: OLD_OWNERSHIP_CAP }, (_row, index) => ({
        id: `mo-${padded(index + 1)}`,
        moduleKey: SCOPES_NOTHING,
      })),
      {
        id: `mo-${padded(OLD_OWNERSHIP_CAP + 1)}`,
        moduleKey: OWNED_MODULE,
      },
    ],
  };
}

/**
 * 501 principal groups, each carrying one role, so both group reads cross the
 * page boundary. The group-role rows are derived from the ids the predicate
 * actually carried: that is what makes the group-MEMBERSHIP cap observable,
 * because a membership dropped one read earlier takes its role with it.
 */
function pastTheGroupCapsFixture(): FixtureRows {
  const groupIds = Array.from(
    { length: GROUPS_PAST_THE_CAP },
    (_row, index) => `${GROUP_PREFIX}${padded(index + 1)}`,
  );
  const roleIds = Array.from(
    { length: GROUPS_PAST_THE_CAP },
    (_row, index) => index + 1,
  );
  return {
    principal_group_members: groupIds.map((principalGroupId, index) => ({
      id: `pgm-${padded(index + 1)}`,
      principalGroupId,
    })),
    group_role_assignments: (whereParams) =>
      whereParams
        .filter(
          (param): param is string =>
            typeof param === "string" && param.startsWith(GROUP_PREFIX),
        )
        .map((_groupId, index) => ({
          id: `gra-${padded(index + 1)}`,
          roleId: index + 1,
        })),
    roles: roleRowsFor(roleIds, GROUPS_PAST_THE_CAP),
  };
}

function keysMissingFrom(
  explained: Record<string, DataScope>,
  authoritative: Record<string, DataScope>,
): string[] {
  return Object.keys(authoritative).filter(
    (key) => explained[key] === undefined,
  );
}

describe("AccessExplainResolver parity with computeUserPermissions", () => {
  it("resolves an identical effective scope map for a member holding every grant path", async () => {
    const fixture = everyGrantPathFixture();

    const authoritative = await makeRealResolver(
      makeFixtureDb(fixture),
      {},
    ).computeUserPermissions("org-1", "user-1", 1);
    const explanation = await makeExplainResolver(
      makeFixtureDb(fixture),
      {},
    ).explain("org-1", "user-1");

    expect(effectiveScopesOf(explanation.permissions)).toEqual(
      authoritative.perms,
    );
    expect(explanation.permissions.length).toBeGreaterThan(0);
  });

  it("resolves an identical effective scope map for an org admin", async () => {
    const fixture = everyGrantPathFixture();
    const member = { role: "ORG_ADMIN" };

    const authoritative = await makeRealResolver(
      makeFixtureDb(fixture),
      member,
    ).computeUserPermissions("org-1", "user-1", 1);
    const explanation = await makeExplainResolver(
      makeFixtureDb(fixture),
      member,
    ).explain("org-1", "user-1");

    expect(effectiveScopesOf(explanation.permissions)).toEqual(
      authoritative.perms,
    );
    expect(explanation.standing).toBe("ORG_ADMIN");
  });

  it("resolves an identical effective scope map for the org owner", async () => {
    const fixture = everyGrantPathFixture();
    const member = { isOwner: true, role: "OWNER" };

    const authoritative = await makeRealResolver(
      makeFixtureDb(fixture),
      member,
    ).computeUserPermissions("org-1", "user-1", 1);
    const explanation = await makeExplainResolver(
      makeFixtureDb(fixture),
      member,
    ).explain("org-1", "user-1");

    expect(effectiveScopesOf(explanation.permissions)).toEqual(
      authoritative.perms,
    );
    expect(explanation.standing).toBe("OWNER");
  });

  it("resolves an identical effective scope map for a member with no grants at all", async () => {
    const empty: FixtureRows = {};

    const authoritative = await makeRealResolver(
      makeFixtureDb(empty),
      {},
    ).computeUserPermissions("org-1", "user-1", 1);
    const explanation = await makeExplainResolver(
      makeFixtureDb(empty),
      {},
    ).explain("org-1", "user-1");

    expect(effectiveScopesOf(explanation.permissions)).toEqual(
      authoritative.perms,
    );
  });
});

describe("AccessExplainResolver parity past the page boundary", () => {
  it("ANTI-VACUITY: the late role and the late ownership each decide keys nothing else in the fixture grants", () => {
    expect(ASSIGNMENTS_PAST_THE_CAP).toBeGreaterThan(OLD_ASSIGNMENT_CAP);
    expect(GROUPS_PAST_THE_CAP).toBeGreaterThan(OLD_ASSIGNMENT_CAP);
    expect(ADMIN_ONLY_KEYS.length).toBeGreaterThan(0);
    expect(OWNED_MODULE_KEYS.length).toBeGreaterThan(0);
    expect(moduleScopedPermissions(SCOPES_NOTHING)).toEqual([]);
  });

  it("agrees with the authority across 1,201 role assignments and 101 module ownerships", async () => {
    const fixture = pastTheStandingCapsFixture();

    const authoritative = await makeRealResolver(
      makeFixtureDb(fixture),
      {},
    ).computeUserPermissions("org-1", "user-1", 1);
    const explanation = await makeExplainResolver(
      makeFixtureDb(fixture),
      {},
    ).explain("org-1", "user-1");
    const explained = effectiveScopesOf(explanation.permissions);

    expect(ADMIN_ONLY_KEYS.filter((key) => authoritative.perms[key] === undefined)).toEqual([]);
    expect(OWNED_MODULE_KEYS.filter((key) => authoritative.perms[key] === undefined)).toEqual([]);
    expect(keysMissingFrom(explained, authoritative.perms)).toEqual([]);
    expect(explained).toEqual(authoritative.perms);
  });

  it("agrees with the authority across 501 principal groups and the 501 roles they carry", async () => {
    const fixture = pastTheGroupCapsFixture();

    const authoritative = await makeRealResolver(
      makeFixtureDb(fixture),
      {},
    ).computeUserPermissions("org-1", "user-1", 1);
    const explanation = await makeExplainResolver(
      makeFixtureDb(fixture),
      {},
    ).explain("org-1", "user-1");
    const explained = effectiveScopesOf(explanation.permissions);

    expect(ADMIN_ONLY_KEYS.filter((key) => authoritative.perms[key] === undefined)).toEqual([]);
    expect(keysMissingFrom(explained, authoritative.perms)).toEqual([]);
    expect(explained).toEqual(authoritative.perms);
  });
});

describe("AccessExplainResolver provenance", () => {
  async function explainEveryGrantPath(): Promise<AccessExplanation> {
    return makeExplainResolver(makeFixtureDb(everyGrantPathFixture()), {}, {
      crm: true,
    }).explain("org-1", "user-1");
  }

  it("names the personal grant that broadened a role grant, and keeps both sources", async () => {
    const explanation = await explainEveryGrantPath();
    const entry = explanation.permissions.find(
      (permission) => permission.permissionKey === GRANTED_VIEW_KEY,
    );
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe("all");
    expect(entry?.sources.map((source) => source.kind)).toEqual(
      expect.arrayContaining(["role-grant", "user-grant"]),
    );
  });

  it("attributes a delegated key to the delegation and carries its end date", async () => {
    const explanation = await explainEveryGrantPath();
    const entry = explanation.permissions.find(
      (permission) => permission.permissionKey === DELEGATED_KEY,
    );
    const delegation = entry?.sources.find(
      (source) => source.kind === "delegation",
    );
    expect(delegation?.expiresAt).toEqual(FAR_FUTURE);
  });

  it("reports no expiry for a key that any permanent source also grants", async () => {
    const explanation = await explainEveryGrantPath();
    for (const entry of explanation.permissions) {
      const permanent = entry.sources.some(
        (source) => source.expiresAt === null,
      );
      if (permanent) expect(entry.expiresAt).toBeNull();
    }
  });

  it("reports the role assignment expiry when the expiring role is the only source", async () => {
    const explanation = await explainEveryGrantPath();
    const expiring = explanation.permissions.filter(
      (entry) =>
        entry.sources.length > 0 &&
        entry.sources.every((source) => source.expiresAt !== null),
    );
    for (const entry of expiring) expect(entry.expiresAt).not.toBeNull();
  });

  it("never attributes an org-only or unknown key, because neither resolves", async () => {
    const explanation = await explainEveryGrantPath();
    const keys = explanation.permissions.map((entry) => entry.permissionKey);
    expect(keys).not.toContain(UNKNOWN_KEY);
    if (ORG_ONLY_KEY) expect(keys).not.toContain(ORG_ONLY_KEY);
  });

  it("marks the owned module as owned and reports entitlement separately from authority", async () => {
    const explanation = await makeExplainResolver(
      makeFixtureDb(everyGrantPathFixture()),
      {},
      { crm: true, inventory: false },
    ).explain("org-1", "user-1");
    const crm = explanation.moduleStandings.find(
      (standing) => standing.moduleKey === "crm",
    );
    expect(crm?.standing).toBe("owner");
    expect(crm?.available).toBe(true);
  });

  it("reports a module the person holds keys in but the organization never enabled as unavailable", async () => {
    const explanation = await makeExplainResolver(
      makeFixtureDb(everyGrantPathFixture()),
      {},
      {},
    ).explain("org-1", "user-1");
    const unavailable = explanation.moduleStandings.filter(
      (standing) => !standing.available,
    );
    expect(unavailable.length).toBeGreaterThan(0);
    for (const standing of unavailable)
      expect(standing.moduleKey).not.toBe("home");
  });

  it("returns nothing at all for an inactive membership", async () => {
    const resolver = new AccessExplainResolver(
      makeFixtureDb(everyGrantPathFixture()),
      makeMembershipStateStub({ active: false, role: "MEMBER" }),
      makeEntitlementsStub(),
    );
    const explanation = await resolver.explain("org-1", "user-1");
    expect(explanation.active).toBe(false);
    expect(explanation.permissions).toEqual([]);
    expect(explanation.moduleStandings).toEqual([]);
  });
});

describe("restrictExplanationTo", () => {
  it("drops a key the authoritative map does not carry and re-counts its module", async () => {
    const explanation = await makeExplainResolver(
      makeFixtureDb(everyGrantPathFixture()),
      {},
      { crm: true },
    ).explain("org-1", "user-1");
    const authoritative: Record<string, DataScope> = {
      [GRANTED_VIEW_KEY]: "own",
    };

    const restricted = restrictExplanationTo(explanation, authoritative);

    expect(restricted.permissions.map((entry) => entry.permissionKey)).toEqual([
      GRANTED_VIEW_KEY,
    ]);
    expect(restricted.permissions[0]?.scope).toBe("own");
    for (const standing of restricted.moduleStandings)
      expect(standing.permissionCount).toBeLessThanOrEqual(1);
  });
});
