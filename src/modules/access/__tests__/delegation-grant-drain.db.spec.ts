/**
 * The catalog half of the delegated-permission drain.
 *
 * `delegation-grant-drain.spec.ts` proves the resolver keeps asking for pages.
 * It cannot prove the SQL those pages are made of is correct, because a mocked
 * chain returns whatever it was told: the drain pages on the COMPOSITE key
 * `(delegation_id, permission_key)` — `user_delegation_permissions` has no `id`
 * column, its primary key IS that pair — and whether a composite keyset over an
 * inner join actually partitions the result set is a fact about Postgres and its
 * text collation, not about the mock.
 *
 * So this runs the real drain against a real database, alongside the exact
 * pre-fix query as a control, and shows the control losing rows on the same
 * fixture. Rows are seeded under a unique id prefix on an existing organisation
 * and deleted in `finally`, leaving the database as it was found.
 *
 *   DATABASE_URL=postgresql://… \
 *     npx jest --config jest-db.json --runInBand --testPathPattern="delegation-grant-drain.db"
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// The namespace is what `drizzle(client, { schema })` needs to produce a value of
// type `Db`, which is `PostgresJsDatabase<typeof schema>` — the house `.db.spec.ts`
// shape. The restriction guards the legacy CRM identity tables; this file touches
// none of them, only the two RBAC delegation tables.
// eslint-disable-next-line no-restricted-imports -- namespace needed for the Db type; no CRM identity table is referenced here
import * as schema from "../../../db/schema";
import {
  organizationMembers,
  permissions,
  userDelegationPermissions,
  userDelegations,
} from "../../../db/schema";
import { drainDelegatedPermissionGrants } from "../access-grant-drains";

const DB_URL = process.env.ACCESS_PROBE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

jest.setTimeout(180_000);

/** Mirrors `GRANT_PAGE_SIZE` in access-grant-drains.ts. */
const PAGE_SIZE = 500;
/** `createDelegationSchema` caps ONE delegation here. Nothing caps how many. */
const PERMISSIONS_PER_DELEGATION = 200;
const DELEGATION_COUNT = 4;

const SUFFIX = randomUUID().slice(0, 8);
const ID_PREFIX = `drain-probe-${SUFFIX}-`;

describe("drainDelegatedPermissionGrants — real catalog", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let orgId: string;
  let delegatorId: number;
  let delegateeId: number;
  let seededKeys: string[][] = [];

  beforeAll(async () => {
    if (!DB_URL) throw new Error("delegation-grant-drain.db.spec.ts requires ACCESS_PROBE_DATABASE_URL or DATABASE_URL");
    client = postgres(DB_URL, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    db = drizzle(client, { schema });

    // Two ACTIVE memberships in one organisation — a delegator and a delegatee.
    const members = await db
      .select({ id: organizationMembers.id, orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(eq(organizationMembers.status, "ACTIVE"))
      .orderBy(organizationMembers.orgId, organizationMembers.id);
    const grouped = new Map<string, number[]>();
    for (const m of members) {
      grouped.set(m.orgId, [...(grouped.get(m.orgId) ?? []), m.id]);
    }
    const pair = [...grouped.entries()]
      .map(([org, ids]) => ({ org, delegator: ids[0], delegatee: ids[1] }))
      .find((candidate) => candidate.delegator !== undefined && candidate.delegatee !== undefined);
    if (!pair || pair.delegator === undefined || pair.delegatee === undefined) {
      throw new Error("probe needs an org with two ACTIVE memberships");
    }
    orgId = pair.org;
    delegatorId = pair.delegator;
    delegateeId = pair.delegatee;

    const catalog = await db
      .select({ name: permissions.name })
      .from(permissions)
      .orderBy(permissions.name);
    const names = catalog.map((row) => row.name);
    if (names.length < PERMISSIONS_PER_DELEGATION) {
      throw new Error("probe needs a seeded permission catalog");
    }

    const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const startsAt = new Date(Date.now() - 60 * 60 * 1000);
    seededKeys = [];
    for (let i = 0; i < DELEGATION_COUNT; i += 1) {
      const id = `${ID_PREFIX}${i}`;
      // Windows that walk the catalog, so the fixture spans the key space
      // instead of repeating one slice under four ids.
      const start = (i * 150) % Math.max(1, names.length - PERMISSIONS_PER_DELEGATION);
      const keys = names.slice(start, start + PERMISSIONS_PER_DELEGATION);
      seededKeys.push(keys);
      await db.insert(userDelegations).values({
        id,
        orgId,
        delegatorMembershipId: delegatorId,
        delegateeMembershipId: delegateeId,
        startsAt,
        endsAt,
        status: "ACTIVE",
      });
      await db.insert(userDelegationPermissions).values(
        keys.map((permissionKey) => ({
          orgId,
          delegationId: id,
          permissionKey,
        })),
      );
    }
  });

  afterAll(async () => {
    try {
      await db
        .delete(userDelegationPermissions)
        .where(
          and(
            eq(userDelegationPermissions.orgId, orgId),
            like(userDelegationPermissions.delegationId, `${ID_PREFIX}%`),
          ),
        );
      await db
        .delete(userDelegations)
        .where(
          and(
            eq(userDelegations.orgId, orgId),
            like(userDelegations.id, `${ID_PREFIX}%`),
          ),
        );
    } finally {
      await client.end();
    }
  });

  const passThrough = <Result>(read: () => PromiseLike<Result>): Promise<Result> =>
    Promise.resolve(read());

  it("ANTI-VACUITY: the seeded fixture is larger than one page", () => {
    const total = seededKeys.reduce((n, keys) => n + keys.length, 0);
    expect(total).toBe(DELEGATION_COUNT * PERMISSIONS_PER_DELEGATION);
    expect(total).toBeGreaterThan(PAGE_SIZE);
  });

  it("CONTROL: the pre-fix single `.limit(500)` read loses rows on this fixture", async () => {
    const now = new Date();
    const truncated = await db
      .select({ permissionKey: userDelegationPermissions.permissionKey })
      .from(userDelegationPermissions)
      .innerJoin(
        userDelegations,
        and(
          eq(userDelegations.orgId, userDelegationPermissions.orgId),
          eq(userDelegations.id, userDelegationPermissions.delegationId),
        ),
      )
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          eq(userDelegations.delegateeMembershipId, delegateeId),
          eq(userDelegations.status, "ACTIVE"),
          gt(userDelegations.endsAt, now),
        ),
      )
      .limit(PAGE_SIZE);

    expect(truncated.length).toBe(PAGE_SIZE);
    const seededTotal = seededKeys.reduce((n, keys) => n + keys.length, 0);
    expect(truncated.length).toBeLessThan(seededTotal);
  });

  it("drains every seeded row, with no duplicate and no gap", async () => {
    const now = new Date();
    const drained = await drainDelegatedPermissionGrants(
      db,
      passThrough,
      orgId,
      delegateeId,
      now,
    );

    const seededTotal = seededKeys.reduce((n, keys) => n + keys.length, 0);
    expect(drained.length).toBe(seededTotal);

    // Multiplicity, not just membership: a keyset that overlaps returns a key
    // more often than it was seeded, and one that skips returns it less.
    const expected = new Map<string, number>();
    for (const keys of seededKeys) {
      for (const key of keys) expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    const actual = new Map<string, number>();
    for (const row of drained) {
      actual.set(row.permissionKey, (actual.get(row.permissionKey) ?? 0) + 1);
    }
    expect(actual.size).toBe(expected.size);
    const mismatched = [...expected.entries()].filter(
      ([key, count]) => actual.get(key) !== count,
    );
    expect(mismatched).toEqual([]);
  });

  it("returns the same set twice — the ordering is total, not plan-dependent", async () => {
    const now = new Date();
    const first = await drainDelegatedPermissionGrants(db, passThrough, orgId, delegateeId, now);
    const second = await drainDelegatedPermissionGrants(db, passThrough, orgId, delegateeId, now);

    const keysOf = (rows: { permissionKey: string }[]): string[] =>
      rows.map((r) => r.permissionKey).sort();
    expect(keysOf(second)).toEqual(keysOf(first));
  });

  it("an expired delegation contributes nothing, so the drain is not just reading everything", async () => {
    const past = new Date(Date.now() + 48 * 60 * 60 * 1000);
    // `now` beyond every seeded `endsAt`: the expiry predicate must empty it.
    const drained = await drainDelegatedPermissionGrants(
      db,
      passThrough,
      orgId,
      delegateeId,
      past,
    );
    expect(drained).toEqual([]);
  });
});
