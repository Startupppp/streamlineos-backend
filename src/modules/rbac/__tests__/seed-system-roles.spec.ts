import {
  MODULE_ADMIN_MODULES,
  scopeForGrant,
  seedSystemRolesForOrg,
  systemRoleSpecs,
} from "../seed-system-roles";
import { ACCESS_MANAGED_MODULES, PERMISSIONS } from "../permissions";

const ORG_ID = "org-seed-test";
const ORG_WIDE_SYSTEM_ROLES = 2;
const EXPECTED_SYSTEM_ROLE_COUNT =
  ORG_WIDE_SYSTEM_ROLES +
  MODULE_ADMIN_MODULES.length +
  ACCESS_MANAGED_MODULES.length * 2;

const CATALOG = new Set(PERMISSIONS.map((p) => p.name));

interface RoleValues {
  slug: string;
  name: string;
  orgId: string;
  isSystem: boolean;
  rank: number;
  moduleKey: string | null;
}

interface GrantValues {
  orgId: string;
  roleId: number;
  permissionKey: string;
  scope: string;
}

interface Recorded {
  table: string;
  rows: unknown[];
}

/**
 * A database that records what was actually written, rather than counting how
 * often a mock was reached.
 *
 * `existingSlugs` is what makes re-seeding testable: Postgres' `ON CONFLICT DO
 * NOTHING ... RETURNING` returns only the rows it really inserted, so a fake
 * that returns everything would let a regression that re-grants an owner's
 * revoked permission pass.
 */
function buildDb(existingSlugs: readonly string[] = []) {
  const statements: Recorded[] = [];
  let nextRoleId = 1;

  const insert = jest.fn().mockImplementation((table: unknown) => {
    const name = tableNameOf(table);
    const chain: Record<string, unknown> = {};
    let captured: unknown[] = [];

    chain.values = jest.fn().mockImplementation((rows: unknown) => {
      captured = Array.isArray(rows) ? rows : [rows];
      statements.push({ table: name, rows: captured });
      return chain;
    });
    chain.onConflictDoNothing = jest.fn().mockReturnValue(chain);
    chain.onConflictDoUpdate = jest.fn().mockReturnValue(chain);
    chain.returning = jest.fn().mockImplementation(async () =>
      (captured as RoleValues[])
        .filter((row) => !existingSlugs.includes(row.slug))
        .map((row) => ({ id: nextRoleId++, slug: row.slug })),
    );
    return chain;
  });

  const tx = { insert };
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([...CATALOG].map((name) => ({ name }))),
      }),
    }),
    transaction: jest
      .fn()
      .mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const rowsFor = <T>(table: string): T[] =>
    statements.filter((s) => s.table === table).flatMap((s) => s.rows as T[]);

  return { db, statements, rowsFor };
}

function tableNameOf(table: unknown): string {
  const symbols = Object.getOwnPropertySymbols(table as object);
  for (const symbol of symbols) {
    if (!symbol.description?.includes("Name")) continue;
    const value = (table as Record<symbol, unknown>)[symbol];
    if (typeof value === "string") return value;
  }
  return "unknown";
}

describe("the system role ladder", () => {
  it("gives a fresh organisation every rung", async () => {
    const { db, rowsFor } = buildDb();

    const result = await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(result.created).toBe(EXPECTED_SYSTEM_ROLE_COUNT);
    const slugs = rowsFor<RoleValues>("roles").map((row) => row.slug);
    expect(new Set(slugs).size).toBe(EXPECTED_SYSTEM_ROLE_COUNT);
    expect(slugs).toContain("ORG_ADMIN");
    expect(slugs).toContain("MEMBER");
    for (const mod of ACCESS_MANAGED_MODULES) {
      expect(slugs).toContain(`${mod.toUpperCase()}_MODULE_OWNER`);
      expect(slugs).toContain(`${mod.toUpperCase()}_MODULE_MEMBER`);
    }
  });

  it("writes the grants each rung is supposed to hold", async () => {
    const { db, rowsFor } = buildDb();

    await seedSystemRolesForOrg(db as never, ORG_ID);

    const expected = systemRoleSpecs(CATALOG).reduce(
      (total, spec) => total + spec.permissionKeys.length,
      0,
    );
    const grants = rowsFor<GrantValues>("role_permission_grants");
    expect(grants).toHaveLength(expected);
    expect(grants.every((grant) => grant.orgId === ORG_ID)).toBe(true);
  });

  /**
   * The invariant migration 0436 exists to protect: a re-seed must not restore a
   * permission an owner deliberately revoked.
   */
  it("touches nothing when every rung already exists", async () => {
    const everySlug = systemRoleSpecs(CATALOG).map((spec) => spec.slug);
    const { db, rowsFor } = buildDb(everySlug);

    const result = await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(result.created).toBe(0);
    expect(rowsFor("role_permission_grants")).toHaveLength(0);
    expect(rowsFor("access_versions")).toHaveLength(0);
  });

  it("grants only to the rungs it created, when some already exist", async () => {
    const { db, rowsFor } = buildDb(["ORG_ADMIN", "MEMBER"]);

    const result = await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(result.created).toBe(EXPECTED_SYSTEM_ROLE_COUNT - 2);
    const createdIds = new Set(
      rowsFor<GrantValues>("role_permission_grants").map((grant) => grant.roleId),
    );
    expect(createdIds.size).toBe(EXPECTED_SYSTEM_ROLE_COUNT - 2);
  });

  it("narrows a module member's scope where the ladder says to", () => {
    expect(scopeForGrant("SIGN_MODULE_MEMBER", "sign:envelope:view")).toBe("own");
    expect(scopeForGrant("SIGN_MODULE_ADMIN", "sign:envelope:view")).toBe("all");
    expect(scopeForGrant("SIGN_MODULE_MEMBER", "sign:envelope:create")).toBe("all");
  });
});

/**
 * The reason self-serve signup took over a minute.
 *
 * Forty-one roles used to mean forty-one transactions, each costing BEGIN, two
 * inserts, a version bump and COMMIT against a Neon endpoint -- two hundred-odd
 * round trips for work that is trivial on the server. What matters is not that
 * batching happens but that the cost stops scaling with the ladder, so this
 * asserts the round-trip count directly and would fail the moment a loop
 * reappears.
 */
describe("what seeding costs", () => {
  it("does not spend a transaction per role", async () => {
    const { db } = buildDb();

    await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("issues a statement count that does not grow with the number of roles", async () => {
    const { db, statements } = buildDb();

    const result = await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(result.created).toBe(EXPECTED_SYSTEM_ROLE_COUNT);
    expect(statements.length).toBeLessThan(EXPECTED_SYSTEM_ROLE_COUNT / 4);
    expect(statements.filter((s) => s.table === "roles")).toHaveLength(1);
  });

  it("bumps the access version once, not once per role", async () => {
    const { db, rowsFor } = buildDb();

    await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(rowsFor("access_versions")).toHaveLength(1);
  });
});
