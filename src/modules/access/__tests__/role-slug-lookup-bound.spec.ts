import { memberRowReader } from "../../../../test/helpers/membership-state-stub";
import { AccessPermissionResolver } from "../access-permission.resolver";
import type { MembershipAccessState } from "../access-permission.resolver";
import type { Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import {
  ALL_PERMISSION_NAMES,
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
} from "../../rbac/permissions";
import { EMPLOYEE_SELF_SERVICE_GRANTS } from "../access-policy";

/**
 * `computeUserPermissions` looks the role slugs up with a single read bounded by
 * `roleIdList.length`. It used to be a constant `.limit(500)` while the id list
 * unions two 500-row reads — the direct role assignments and the group-derived
 * ones — so a membership resolving more than 500 distinct roles lost the slug
 * record for every role past the cap. A role with no explicit grant rows falls
 * back to `ROLE_DEFAULT_PERMISSIONS[record.slug]`; with no record that fallback
 * is the empty list, so the role's whole default permission set vanished, with
 * no `ORDER BY` to even make it the same set twice.
 *
 * The fixture is deliberately larger than the old constant. A membership with
 * 500 roles or fewer cannot catch this, which is why it survived.
 */

const OLD_CONSTANT_CAP = 500;
const DIRECT_ROLE_COUNT = 500;
const GROUP_ROLE_COUNT = 500;
const ADMIN_ROLE_ID = DIRECT_ROLE_COUNT + GROUP_ROLE_COUNT;
const ORG = "org-slug-bound";
const USER = "user-slug-bound";

const DIRECT_ROLE_IDS = Array.from(
  { length: DIRECT_ROLE_COUNT },
  (_unused, index) => index + 1,
);
const GROUP_ROLE_IDS = Array.from(
  { length: GROUP_ROLE_COUNT },
  (_unused, index) => DIRECT_ROLE_COUNT + index + 1,
);
const ALL_ROLE_IDS = [...DIRECT_ROLE_IDS, ...GROUP_ROLE_IDS];

/**
 * Only `ADMIN_ROLE_ID` carries a slug with defaults; every other role is a
 * custom slug that resolves to nothing either way, so the assertion below can
 * only be satisfied by the last id in the list surviving the read.
 */
function slugFor(roleId: number): string {
  return roleId === ADMIN_ROLE_ID ? "ORG_ADMIN" : `CUSTOM_ROLE_${roleId}`;
}

const ALWAYS_GRANTED = new Set<string>([
  ...UNIVERSAL_MEMBER_PERMISSION_GRANTS.map((grant) => grant.permissionKey),
  ...EMPLOYEE_SELF_SERVICE_GRANTS.map((grant) => grant.permissionKey),
]);

/** The keys the admin slug's defaults are the ONLY source of in this fixture. */
const ADMIN_ONLY_KEYS = (ROLE_DEFAULT_PERMISSIONS.ORG_ADMIN ?? []).filter(
  (key) => !ALWAYS_GRANTED.has(key),
);

interface Chain {
  from: (table?: unknown) => Chain;
  where: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  limit: (count?: number) => Promise<unknown[]>;
}

interface RoleRecord {
  id: number;
  slug: string;
}

/** Ids sort as text, so zero-padding keeps the keyset order the row order. */
function padded(index: number): string {
  return String(index).padStart(6, "0");
}

const ASSIGNMENT_ROWS = DIRECT_ROLE_IDS.map((roleId) => ({
  id: `ra-${padded(roleId)}`,
  roleId,
  expiresAt: null,
}));

const GROUP_ROLE_ROWS = GROUP_ROLE_IDS.map((roleId, index) => ({
  id: `gr-${padded(index + 1)}`,
  roleId,
}));

/**
 * Routes on the projection, which is unique per read, and — unlike the other
 * chain mocks in this folder — HONOURS the `limit` argument on the role-slug
 * read. That is the whole point: a mock that ignores `.limit()` cannot see this
 * defect, because the truncation happens in Postgres, not in the resolver.
 *
 * The two standing reads project `id` and serve a real page SEQUENCE for the
 * same reason. They used to answer every page with the same 500 rows and no `id`
 * at all, so the keyset cursor could not advance: the drain logged
 * "cursor did not advance" and stopped, and the spec still passed only because
 * the duplicated role ids collapsed into a `Set`.
 */
function makeDb(): {
  db: Db;
  slugReadLimit: () => number | undefined;
  slugRowsServed: () => number;
} {
  let slugReadLimit: number | undefined;
  let slugRowsServed = 0;
  const served = new Map<string, number>();

  const pageFrom = (site: string, rows: readonly unknown[], count: number) => {
    const from = served.get(site) ?? 0;
    const page = rows.slice(from, from + count);
    served.set(site, from + page.length);
    return Promise.resolve(page);
  };

  const db = {
    query: {
    },
    select: (projection?: Record<string, unknown>) => {
      const columns = new Set(Object.keys(projection ?? {}));
      const chain: Chain = {
        from: () => chain,
        where: () => chain,
        innerJoin: () => chain,
        orderBy: () => chain,
        limit: (count?: number) => {
          const size = count ?? OLD_CONSTANT_CAP;
          if (columns.has("roleId") && columns.has("expiresAt"))
            return pageFrom("assignments", ASSIGNMENT_ROWS, size);
          if (columns.has("principalGroupId"))
            return Promise.resolve([{ id: "pgm-000001", principalGroupId: 1 }]);
          if (columns.has("moduleKey")) return Promise.resolve([]);
          if (columns.has("id") && columns.has("slug")) {
            slugReadLimit = count;
            const rows: RoleRecord[] = ALL_ROLE_IDS.map((roleId) => ({
              id: roleId,
              slug: slugFor(roleId),
            })).slice(0, count ?? ALL_ROLE_IDS.length);
            slugRowsServed = rows.length;
            return Promise.resolve(rows);
          }
          if (columns.has("roleId") && columns.has("permissionKey"))
            return Promise.resolve([]);
          if (columns.has("delegationId")) return Promise.resolve([]);
          if (columns.has("permissionKey")) return Promise.resolve([]);
          if (columns.has("roleId"))
            return pageFrom("group-roles", GROUP_ROLE_ROWS, size);
          return Promise.resolve([]);
        },
      };
      return chain;
    },
  };

  return {
    db: db as unknown as Db,
    slugReadLimit: () => slugReadLimit,
    slugRowsServed: () => slugRowsServed,
  };
}

function makeResolver(db: Db): AccessPermissionResolver {
  const safeRead = <Result>(read: () => PromiseLike<Result>): Promise<Result> =>
    Promise.resolve(read());
  return new AccessPermissionResolver(
    () => db,
    safeRead,
    new Set<string>(),
    new Map<string, MembershipAccessState>(),
    15_000,
    memberRowReader({ isOwner: false, status: "ACTIVE", id: 1, role: "MEMBER", }),
  );
}

describe("computeUserPermissions — the role-slug read is bounded by the id list", () => {
  it("ANTI-VACUITY: the fixture holds more distinct roles than the old constant cap", () => {
    expect(ALL_ROLE_IDS.length).toBeGreaterThan(OLD_CONSTANT_CAP);
    expect(new Set(ALL_ROLE_IDS).size).toBe(ALL_ROLE_IDS.length);
  });

  it("ANTI-VACUITY: the admin slug contributes keys nothing else in the fixture grants", () => {
    expect(ADMIN_ONLY_KEYS.length).toBeGreaterThan(0);
    expect(ALL_PERMISSION_NAMES).toEqual(expect.arrayContaining(ADMIN_ONLY_KEYS));
  });

  it("asks for exactly as many role rows as there are ids, never a constant", async () => {
    const { db, slugReadLimit, slugRowsServed } = makeDb();

    await makeResolver(db).computeUserPermissions(ORG, USER, 1);

    expect(slugReadLimit()).toBe(ALL_ROLE_IDS.length);
    expect(slugRowsServed()).toBe(ALL_ROLE_IDS.length);
  });

  it("advances the keyset cursor on every drained page, so the drain never stops early", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { db } = makeDb();

      await makeResolver(db).computeUserPermissions(ORG, USER, 1);

      const stalled = warn.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" && call[0].includes("did not advance"),
      );
      expect(stalled).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the defaults of a role sitting past the old cap in the id list", async () => {
    const { db } = makeDb();

    const { perms } = await makeResolver(db).computeUserPermissions(
      ORG,
      USER,
      1,
    );

    const missing = ADMIN_ONLY_KEYS.filter((key) => perms[key] === undefined);
    expect(missing).toEqual([]);
  });
});
