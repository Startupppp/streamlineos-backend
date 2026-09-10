import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
// The relational query builder needs the whole schema map to resolve `with`
// clauses; this spec reads only billing tables through it and touches no
// legacy identity table.
// eslint-disable-next-line no-restricted-imports
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { VersionedCatalogService } from "../versioned-catalog.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { dbSpecClient, dbSpecSuite, dbSpecUrl } from "../../../../test/db-spec-gate";
import { ensureFixtureOrgs } from "../../../../test/db-spec-fixture";

/**
 * `upsertOrgEntitlementOverride` against a real partial unique index.
 *
 * The index it arbitrates on, `uq_org_ent_overrides_idem`, is partial:
 * `WHERE idempotency_key IS NOT NULL`. PostgreSQL infers a partial index only
 * when the statement repeats that predicate, so the version of this method
 * without `targetWhere` was not merely unprotected — every call raised
 * 42P10 before touching a row.
 *
 * The existing unit spec calls this same method twice and passes, because its
 * database is a mock: it asserts the arguments and never asks PostgreSQL
 * whether the statement is legal. That is the whole reason this file connects.
 * A mock cannot hold an index, so it cannot refuse.
 *
 * Run with:
 *   DATABASE_URL=postgres://... pnpm test:db --testPathPattern=entitlement-override-upsert
 */

const SUITE = dbSpecSuite();
const FEATURE = "dbspec-ent-override-seats";

SUITE("billing entitlement override upsert survives its partial index", () => {
  let sql: ReturnType<typeof dbSpecClient> | null = null;
  let client: ReturnType<typeof postgres> | null = null;
  let service: VersionedCatalogService;
  let orgId = "";
  /** `actor_id` is a real FK to `users`; the fixture org brings its owner. */
  let actorId = "";

  beforeAll(async () => {
    const url = dbSpecUrl();
    sql = dbSpecClient(url);
    [{ orgId, userId: actorId }] = await ensureFixtureOrgs(sql, 1);

    client = postgres(url, { max: 1 });
    const db = drizzle(client, { schema }) as unknown as Db;
    /** Only `invalidate` is reached on this path. */
    const cache = { invalidate: async () => undefined } as unknown as CacheService;
    service = new VersionedCatalogService(db, cache);

    await sql`DELETE FROM org_entitlement_overrides WHERE feature_key = ${FEATURE}`;
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM org_entitlement_overrides WHERE feature_key = ${FEATURE}`;
      await sql.end({ timeout: 5 });
    }
    if (client) await client.end({ timeout: 5 });
  }, 30_000);

  const rows = async () =>
    sql!<{ limit_value: number | null; idempotency_key: string | null }[]>`
      SELECT limit_value, idempotency_key
      FROM org_entitlement_overrides
      WHERE org_id = ${orgId} AND feature_key = ${FEATURE}
      ORDER BY id`;

  it("accepts a first write carrying an idempotency key", async () => {
    await service.upsertOrgEntitlementOverride(orgId, FEATURE, 25, actorId, "negotiated", "idem-1");
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(Number(found[0]!.limit_value)).toBe(25);
  }, 30_000);

  it("folds a replay of the same key into the same row rather than raising", async () => {
    await service.upsertOrgEntitlementOverride(orgId, FEATURE, 40, actorId, "renegotiated", "idem-1");
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(Number(found[0]!.limit_value)).toBe(40);
  }, 30_000);

  /**
   * The other half of the predicate. A row with no idempotency key falls
   * outside the partial index, so the arbiter cannot match it and the insert
   * proceeds — which is the intended reading of "no key means no replay
   * protection", and would be silently wrong if the target were unqualified.
   */
  it("still inserts a keyless override instead of folding it into the keyed one", async () => {
    await service.upsertOrgEntitlementOverride(orgId, FEATURE, 7, actorId, "manual", undefined);
    const found = await rows();
    expect(found).toHaveLength(2);
    expect(found.map((r) => r.idempotency_key).sort()).toEqual(["idem-1", null]);
  }, 30_000);
});
