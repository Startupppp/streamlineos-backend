import { AccessPermissionResolver } from "../access-permission.resolver";
import type { MembershipAccessState } from "../access-permission.resolver";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../access.types";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";
import { isDelegablePermission } from "../../../common/rbac/grantability";

/**
 * `computeUserPermissions` used to read the role grants with a bare, unordered
 * `.limit(500)`. That is one row per `(role, key)` across every role the member
 * holds, and the 14 module-admin rungs sum to 564 keys — so a member holding
 * nine of them silently lost permissions past the 500th, and with no `ORDER BY`
 * a *different* set on each request. An authorization decision that was both
 * wrong and non-deterministic, and raised no error either way.
 *
 * The fixture is deliberately larger than one page. A fixture smaller than the
 * limit cannot catch this, which is exactly why it survived: restore the bare
 * `.limit(500)` and this suite fails on the keys past the page boundary.
 */

const PAGE_SIZE = 500;
const ROLE_ID = 7;
const ORG = "org-drain";
const USER = "user-drain";

/** Real catalog keys — `mergeIfKnown` drops anything the catalog does not carry. */
const GRANTED_KEYS = ALL_PERMISSION_NAMES.filter(isDelegablePermission);

interface GrantRow {
  id: number;
  roleId: number;
  permissionKey: string;
  scope: DataScope;
}

const ALL_GRANT_ROWS: GrantRow[] = GRANTED_KEYS.map((permissionKey, index) => ({
  id: index + 1,
  roleId: ROLE_ID,
  permissionKey,
  scope: "all",
}));

interface Chain {
  from: (table?: unknown) => Chain;
  where: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  limit: () => Promise<unknown[]>;
}

/**
 * Serves the five non-drain reads in their fixed order, and the role-grant drain
 * by page. Two reads now drain by keyset — role grants and per-person grants —
 * so `orderBy` alone no longer identifies this one; the chain routes on the
 * projection instead, which is unique per read. Restoring the bare limit then
 * changes the number of pages served without knocking the other reads out of
 * sequence.
 */
function makeDb(grantRows: GrantRow[]): { db: Db; grantPageCalls: () => number } {
  const nonDrain: unknown[][] = [
    [{ roleId: ROLE_ID, expiresAt: null }],
    [],
    [],
    [{ id: ROLE_ID, slug: "CRM_MODULE_ADMIN" }],
    [],
  ];
  let nonDrainCall = 0;
  let grantPages = 0;
  let cursor = 0;

  const db = {
    query: {
      organizationMembers: {
        findFirst: () =>
          Promise.resolve({ isOwner: false, status: "ACTIVE", id: 1, role: "MEMBER" }),
      },
    },
    select: (projection?: Record<string, unknown>) => {
      const columns = new Set(Object.keys(projection ?? {}));
      const isRoleGrantDrain =
        columns.has("roleId") && columns.has("permissionKey");
      const isUserGrantDrain =
        columns.has("scope") && columns.has("permissionKey") && !columns.has("roleId");
      const chain: Chain = {
        from: () => chain,
        where: () => chain,
        innerJoin: () => chain,
        orderBy: () => chain,
        limit: () => {
          if (isRoleGrantDrain) {
            grantPages += 1;
            const page = grantRows.slice(cursor, cursor + PAGE_SIZE);
            cursor += page.length;
            return Promise.resolve(page);
          }
          if (isUserGrantDrain) return Promise.resolve([]);
          const result = nonDrain[nonDrainCall] ?? [];
          nonDrainCall += 1;
          return Promise.resolve(result);
        },
      };
      return chain;
    },
  };

  return { db: db as unknown as Db, grantPageCalls: () => grantPages };
}

function makeResolver(db: Db): AccessPermissionResolver {
  /**
   * A pass-through, not a swallow. This helper used to catch and return the
   * fallback, which is how a mock chain missing `.orderBy` silently dropped
   * every role grant and still went green (findings register #48). The
   * production reader takes no fallback any more, so neither does this one.
   */
  const safeRead = <Result>(read: () => PromiseLike<Result>): Promise<Result> =>
    Promise.resolve(read());
  return new AccessPermissionResolver(
    () => db,
    safeRead,
    new Set<string>(),
    new Map<string, MembershipAccessState>(),
    15_000,
  );
}

describe("computeUserPermissions — role grants are drained, not truncated", () => {
  it("ANTI-VACUITY: the fixture is larger than one page, so a single read cannot serve it", () => {
    expect(ALL_GRANT_ROWS.length).toBeGreaterThan(PAGE_SIZE);
  });

  it("resolves every granted key, including the ones past the page boundary", async () => {
    const { db, grantPageCalls } = makeDb(ALL_GRANT_ROWS);

    const { perms } = await makeResolver(db).computeUserPermissions(ORG, USER, 1);

    const missing = ALL_GRANT_ROWS.map((row) => row.permissionKey).filter(
      (key) => perms[key] === undefined,
    );
    expect(missing).toEqual([]);

    const beyondFirstPage = ALL_GRANT_ROWS.slice(PAGE_SIZE);
    expect(beyondFirstPage.length).toBeGreaterThan(0);
    for (const row of beyondFirstPage) expect(perms[row.permissionKey]).toBe("all");

    expect(grantPageCalls()).toBeGreaterThan(1);
  });

  it("stops as soon as a page comes back short, rather than looping", async () => {
    const short = ALL_GRANT_ROWS.slice(0, 10);
    const { db, grantPageCalls } = makeDb(short);

    const { perms } = await makeResolver(db).computeUserPermissions(ORG, USER, 1);

    for (const row of short) expect(perms[row.permissionKey]).toBe("all");
    expect(grantPageCalls()).toBe(1);
  });
});
