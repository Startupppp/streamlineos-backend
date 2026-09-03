import { AccessPermissionResolver } from "../access-permission.resolver";
import type { MembershipAccessState } from "../access-permission.resolver";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../access.types";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";
import { isDelegablePermission } from "../../../common/rbac/grantability";

/**
 * `computeUserPermissions` used to read `user_permission_grants` with a bare,
 * unordered `.limit(500)` — the same defect `drainRolePermissionGrants` fixes,
 * one grant path over. The key space is `(org_id, membership_id,
 * permission_key)`, so a person can hold one grant per catalog key; past the
 * page a grant was silently dropped, and with no `ORDER BY` a *different* one on
 * each request.
 *
 * The fixture is deliberately larger than one page. A fixture smaller than the
 * limit cannot catch this, which is exactly why it survived: restore the bare
 * `.limit(500)` — or neuter the drain to a single page — and this suite fails on
 * the keys past the page boundary.
 */

const PAGE_SIZE = 500;
const ORG = "org-user-drain";
const USER = "user-user-drain";

/** Real catalog keys — `mergeIfKnown` drops anything the catalog does not carry. */
const GRANTED_KEYS = ALL_PERMISSION_NAMES.filter(isDelegablePermission);

interface UserGrantRow {
  id: string;
  permissionKey: string;
  scope: DataScope;
}

const ALL_USER_GRANT_ROWS: UserGrantRow[] = GRANTED_KEYS.map(
  (permissionKey, index) => ({
    id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
    permissionKey,
    scope: "all",
  }),
);

interface Chain {
  from: (table?: unknown) => Chain;
  where: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  limit: () => Promise<unknown[]>;
}

/**
 * Routes on the projection, which is unique per read, rather than on call
 * position — the per-person drain issues a variable number of reads, so a
 * positional queue would desynchronise the moment the page count changed.
 */
function makeDb(grantRows: UserGrantRow[]): {
  db: Db;
  userGrantPageCalls: () => number;
} {
  let pages = 0;
  let cursor = 0;

  const db = {
    query: {
      organizationMembers: {
        findFirst: () =>
          Promise.resolve({
            isOwner: false,
            status: "ACTIVE",
            id: 1,
            role: "MEMBER",
          }),
      },
    },
    select: (projection?: Record<string, unknown>) => {
      const columns = new Set(Object.keys(projection ?? {}));
      const isUserGrantDrain =
        columns.has("scope") &&
        columns.has("permissionKey") &&
        !columns.has("roleId");
      const chain: Chain = {
        from: () => chain,
        where: () => chain,
        innerJoin: () => chain,
        orderBy: () => chain,
        limit: () => {
          if (!isUserGrantDrain) return Promise.resolve([]);
          pages += 1;
          const page = grantRows.slice(cursor, cursor + PAGE_SIZE);
          cursor += page.length;
          return Promise.resolve(page);
        },
      };
      return chain;
    },
  };

  return { db: db as unknown as Db, userGrantPageCalls: () => pages };
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

describe("computeUserPermissions — per-person grants are drained, not truncated", () => {
  it("ANTI-VACUITY: the fixture is larger than one page, so a single read cannot serve it", () => {
    expect(ALL_USER_GRANT_ROWS.length).toBeGreaterThan(PAGE_SIZE);
  });

  it("resolves every per-person grant, including the ones past the page boundary", async () => {
    const { db, userGrantPageCalls } = makeDb(ALL_USER_GRANT_ROWS);

    const { perms } = await makeResolver(db).computeUserPermissions(ORG, USER, 1);

    const missing = ALL_USER_GRANT_ROWS.map((row) => row.permissionKey).filter(
      (key) => perms[key] === undefined,
    );
    expect(missing).toEqual([]);

    const beyondFirstPage = ALL_USER_GRANT_ROWS.slice(PAGE_SIZE);
    expect(beyondFirstPage.length).toBeGreaterThan(0);
    for (const row of beyondFirstPage) expect(perms[row.permissionKey]).toBe("all");

    expect(userGrantPageCalls()).toBeGreaterThan(1);
  });

  it("stops as soon as a page comes back short, rather than looping", async () => {
    const short = ALL_USER_GRANT_ROWS.slice(0, 10);
    const { db, userGrantPageCalls } = makeDb(short);

    const { perms } = await makeResolver(db).computeUserPermissions(ORG, USER, 1);

    for (const row of short) expect(perms[row.permissionKey]).toBe("all");
    expect(userGrantPageCalls()).toBe(1);
  });

  it("keeps the scope stored on each grant across the page boundary", async () => {
    const baseline = (
      await makeResolver(makeDb([]).db).computeUserPermissions(ORG, USER, 1)
    ).perms;
    const rows = ALL_USER_GRANT_ROWS.map((row, index) => ({
      ...row,
      scope: (index % 2 === 0 ? "all" : "own") as DataScope,
    }));
    const { db } = makeDb(rows);

    const { perms } = await makeResolver(db).computeUserPermissions(ORG, USER, 1);

    const pastThePage = rows
      .slice(PAGE_SIZE)
      .filter(
        (row) => row.scope === "own" && baseline[row.permissionKey] === undefined,
      );
    expect(pastThePage.length).toBeGreaterThan(0);
    for (const row of pastThePage) expect(perms[row.permissionKey]).toBe("own");
  });
});
