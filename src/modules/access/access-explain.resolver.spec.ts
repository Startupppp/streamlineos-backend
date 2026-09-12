import { getTableName, type Table } from "drizzle-orm";
import { makeMembershipStateStub } from "../../../test/helpers/membership-state-stub";
import type { Db } from "../../db/drizzle.module";
import type { EntitlementsService } from "./entitlements.service";
import { AccessPermissionResolver } from "./access-permission.resolver";
import {
  AccessExplainResolver,
  effectiveScopesOf,
  restrictExplanationTo,
  type AccessExplanation,
} from "./access-explain.resolver";
import type { DataScope } from "./access.types";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import { isDelegablePermission } from "../../common/rbac/grantability";

type FixtureRows = Record<string, unknown[]>;

/**
 * A table-driven Drizzle double.
 *
 * The two resolvers under test issue the same reads in a different ORDER, so a
 * `mockReturnValueOnce` chain would answer one of them with the other's rows and
 * the parity assertion below would compare two wrong maps. Dispatching on the
 * table handed to `.from()` makes the fixture order-free.
 */
function makeFixtureDb(rows: FixtureRows): Db {
  const select = jest.fn(() => {
    let table = "";
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
    chain.where.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    chain.limit.mockImplementation(() => Promise.resolve(rows[table] ?? []));
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
