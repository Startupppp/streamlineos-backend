import { AccessPermissionResolver } from "../access-permission.resolver";
import type { MembershipAccessState } from "../access-permission.resolver";
import type { Db } from "../../../db/drizzle.module";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";
import { isDelegablePermission } from "../../../common/rbac/grantability";

/**
 * `computeUserPermissions` used to read the delegated permissions with a bare,
 * unordered `.limit(500)` — the third instance of the defect
 * `drainRolePermissionGrants` and `drainUserPermissionGrants` already fix.
 *
 * The cap sits on the WRONG side of the fan-out. `delegation.schemas.ts:10`
 * caps ONE delegation at 200 permissions, but nothing caps how many
 * delegations are concurrently ACTIVE against the same delegatee, and the read
 * filters on `delegatee_membership_id` + status + expiry only. An ops lead
 * covering four colleagues on leave holds 4 x 200 rows; 500 came back, the rest
 * were dropped, and with no `ORDER BY` a *different* 500 on each request. The
 * result is then cached under `accessPerms(orgId, userId, version)` for that
 * version's lifetime — authorized at 09:00, denied at 09:05, no error either
 * way.
 *
 * The fixture is deliberately larger than one page and spread over several
 * delegations, because that is the only shape that reproduces it: a fixture
 * inside the limit, or one delegation of 200, passes against the broken read.
 */

const PAGE_SIZE = 500;
const PERMISSIONS_PER_DELEGATION = 200;
const ORG = "org-delegation-drain";
const USER = "user-delegation-drain";

/** Real catalog keys — `mergeIfKnown` drops anything the catalog does not carry. */
const DELEGABLE_KEYS = ALL_PERMISSION_NAMES.filter(isDelegablePermission);

interface DelegatedRow {
  delegationId: string;
  permissionKey: string;
  startsAt: Date;
  endsAt: Date;
}

const STARTED = new Date(Date.now() - 60 * 60 * 1000);
const ENDS = new Date(Date.now() + 24 * 60 * 60 * 1000);

/**
 * Four concurrently ACTIVE delegations, each within the per-delegation cap of
 * `createDelegationSchema`, keyed exactly as the table is: the primary key of
 * `user_delegation_permissions` is `(delegation_id, permission_key)` and the
 * table has NO `id` column, so this is also the order a keyset drain must page
 * in.
 */
const ALL_DELEGATED_ROWS: DelegatedRow[] = DELEGABLE_KEYS.map(
  (permissionKey, index) => ({
    delegationId: `delegation-${String(
      Math.floor(index / PERMISSIONS_PER_DELEGATION),
    ).padStart(4, "0")}`,
    permissionKey,
    startsAt: STARTED,
    endsAt: ENDS,
  }),
).sort((left, right) =>
  left.delegationId === right.delegationId
    ? left.permissionKey.localeCompare(right.permissionKey)
    : left.delegationId.localeCompare(right.delegationId),
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
 * position — the drain issues a variable number of reads, so a positional queue
 * would desynchronise the moment the page count changed.
 */
function makeDb(delegatedRows: DelegatedRow[]): {
  db: Db;
  delegationPageCalls: () => number;
  delegationOrderByCalls: () => number;
} {
  let pages = 0;
  let ordered = 0;
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
      const isDelegationDrain =
        columns.has("permissionKey") &&
        columns.has("startsAt") &&
        columns.has("endsAt");
      const chain: Chain = {
        from: () => chain,
        where: () => chain,
        innerJoin: () => chain,
        orderBy: () => {
          if (isDelegationDrain) ordered += 1;
          return chain;
        },
        limit: () => {
          if (!isDelegationDrain) return Promise.resolve([]);
          pages += 1;
          const page = delegatedRows.slice(cursor, cursor + PAGE_SIZE);
          cursor += page.length;
          return Promise.resolve(page);
        },
      };
      return chain;
    },
  };

  return {
    db: db as unknown as Db,
    delegationPageCalls: () => pages,
    delegationOrderByCalls: () => ordered,
  };
}

function makeResolver(db: Db): AccessPermissionResolver {
  /**
   * A pass-through, not a swallow — the production reader takes no fallback,
   * so neither does this one.
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

describe("computeUserPermissions — delegated permissions are drained, not truncated", () => {
  it("ANTI-VACUITY: the fixture is larger than one page and spans several delegations", () => {
    expect(ALL_DELEGATED_ROWS.length).toBeGreaterThan(PAGE_SIZE);
    const delegations = new Set(ALL_DELEGATED_ROWS.map((r) => r.delegationId));
    expect(delegations.size).toBeGreaterThan(1);
    for (const delegationId of delegations) {
      const held = ALL_DELEGATED_ROWS.filter(
        (r) => r.delegationId === delegationId,
      );
      // Each delegation stays inside `createDelegationSchema`'s own cap, so the
      // fixture is a state the write path can actually produce.
      expect(held.length).toBeLessThanOrEqual(PERMISSIONS_PER_DELEGATION);
    }
  });

  it("resolves every delegated permission, including the ones past the page boundary", async () => {
    const { db, delegationPageCalls } = makeDb(ALL_DELEGATED_ROWS);

    const { perms } = await makeResolver(db).computeUserPermissions(ORG, USER, 1);

    const missing = ALL_DELEGATED_ROWS.map((row) => row.permissionKey).filter(
      (key) => perms[key] === undefined,
    );
    expect(missing).toEqual([]);

    const beyondFirstPage = ALL_DELEGATED_ROWS.slice(PAGE_SIZE);
    expect(beyondFirstPage.length).toBeGreaterThan(0);
    for (const row of beyondFirstPage) {
      expect(perms[row.permissionKey]).toBe("all");
    }

    expect(delegationPageCalls()).toBeGreaterThan(1);
  });

  it("orders the read, so two resolutions of the same state cannot disagree", async () => {
    const { db, delegationOrderByCalls } = makeDb(ALL_DELEGATED_ROWS);

    await makeResolver(db).computeUserPermissions(ORG, USER, 1);

    // Without an ORDER BY the pages overlap and skip, which is how the same
    // person was authorized on one request and denied on the next.
    expect(delegationOrderByCalls()).toBeGreaterThan(0);
  });

  it("stops as soon as a page comes back short, rather than looping", async () => {
    const short = ALL_DELEGATED_ROWS.slice(0, 10);
    const { db, delegationPageCalls } = makeDb(short);

    const { perms } = await makeResolver(db).computeUserPermissions(ORG, USER, 1);

    for (const row of short) expect(perms[row.permissionKey]).toBe("all");
    expect(delegationPageCalls()).toBe(1);
  });

  it("still honours a not-yet-started delegation past the page boundary", async () => {
    const future = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const baseline = (
      await makeResolver(makeDb([]).db).computeUserPermissions(ORG, USER, 1)
    ).perms;
    const rows = ALL_DELEGATED_ROWS.map((row, index) =>
      index >= PAGE_SIZE ? { ...row, startsAt: future } : row,
    );
    const { db } = makeDb(rows);

    const { perms, transitions } = await makeResolver(db).computeUserPermissions(
      ORG,
      USER,
      1,
    );

    // Scheduled-but-not-started rows past the boundary must be READ (so the
    // snapshot expires when they start) and must NOT grant yet.
    const notYet = rows
      .slice(PAGE_SIZE)
      .filter((row) => baseline[row.permissionKey] === undefined);
    expect(notYet.length).toBeGreaterThan(0);
    for (const row of notYet) expect(perms[row.permissionKey]).toBeUndefined();
    expect(transitions.delegationStart?.getTime()).toBe(future.getTime());
  });
});
