import type postgres from "postgres";

/**
 * The data a real-database spec needs before it can assert anything.
 *
 * Four of these suites opened with `SELECT id FROM organizations LIMIT 1` and a
 * non-null assertion, and one picked the organisation with the most ledger rows.
 * Both are readings of whatever a shared branch happened to contain, so on a
 * freshly migrated database — the only kind CI can create, and the only kind a
 * rollback rehearsal may touch — every one of them failed in `beforeAll` on an
 * undefined row, which jest then reported as seventeen broken assertions.
 *
 * So the tier seeds its own floor: a fixed, idempotent pair of organisations and
 * a small ledger, addressed by constant ids. Re-running is a no-op, and a
 * database that already carries a real dataset keeps it — the fixture only adds
 * what is missing.
 *
 * Raw SQL rather than Drizzle on purpose: these specs run under the root jest
 * config, and pulling the schema barrel in would drag the Nest module graph into
 * a file whose whole job is to be cheap to load.
 */

type Client = ReturnType<typeof postgres>;

export interface DbSpecOrg {
  orgId: string;
  userId: string;
  membershipId: number;
}

const ORG_IDS = ["dbspec-fixture-org-a", "dbspec-fixture-org-b"] as const;

/**
 * `organizations.owner_membership_id` and `organization_members.org_id` point at
 * each other. The FK is DEFERRABLE INITIALLY DEFERRED, so both rows can be
 * written in one transaction as long as the membership id is reserved from the
 * sequence before the organisation row names it.
 */
async function createOrg(client: Client, orgId: string): Promise<DbSpecOrg> {
  const userId = `${orgId}-owner`;
  let membershipId = 0;
  await client.begin(async (tx) => {
    const [seq] = await tx<{ id: string }[]>`
      SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`;
    membershipId = Number(seq!.id);
    await tx`
      INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@test.invalid`})
      ON CONFLICT (id) DO NOTHING`;
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id)
      VALUES (${orgId}, ${orgId}, ${orgId}, ${membershipId})
      ON CONFLICT (id) DO NOTHING`;
    await tx`
      INSERT INTO organization_members (id, user_id, org_id, role, is_owner, status)
      VALUES (${membershipId}, ${userId}, ${orgId}, 'OWNER', true, 'ACTIVE')
      ON CONFLICT (id) DO NOTHING`;
    /**
     * Placement, without which this organisation is unreachable to every sweep.
     *
     * `forEachOrg` asks the region registry where an organisation lives, and an
     * unplaced one raises "has no region. It must be placed before its data can
     * be reached." The sweep catches that per organisation and carries on, so
     * nothing breaks — it simply logs two failures on every run of every
     * background worker, forever, in any database this fixture has touched.
     *
     * That noise is not free. It cost an afternoon: an outbox event that would
     * not publish was blamed on these two rows, and the real cause was a cron
     * lease held by a suite running beside it. A fixture that leaves a
     * permanent error in the logs teaches people to read past errors.
     */
    await tx`
      INSERT INTO organization_placement (
        organization_id, region, cell_id, database_shard,
        object_storage_region, search_cluster, write_fence_token, lease_expires_at
      )
      VALUES (
        ${orgId}, 'primary', 'legacy-1', 'primary',
        'primary', 'primary', gen_random_uuid()::text, now() + interval '100 years'
      )
      ON CONFLICT (organization_id) DO NOTHING`;
  });
  return { orgId, userId, membershipId };
}

/**
 * The fixture organisations, created once and reused.
 *
 * `created_at` ordering matters to the RLS probes, which take the first two
 * organisations in creation order; the fixture pair is created in list order and
 * a database that already holds organisations keeps whichever it had first.
 */
export async function ensureFixtureOrgs(
  client: Client,
  count: 1 | 2 = 1,
): Promise<DbSpecOrg[]> {
  const out: DbSpecOrg[] = [];
  for (const orgId of ORG_IDS.slice(0, count)) {
    const [existing] = await client<{ id: string; owner_membership_id: number }[]>`
      SELECT id, owner_membership_id FROM organizations WHERE id = ${orgId}`;
    if (existing) {
      out.push({
        orgId,
        userId: `${orgId}-owner`,
        membershipId: Number(existing.owner_membership_id),
      });
      continue;
    }
    out.push(await createOrg(client, orgId));
  }
  return out;
}

/**
 * An organisation with at least `minimum` ledger rows, and the variant they hang
 * off.
 *
 * The cursor probes walk pages of 25 and assert they crossed a page boundary, so
 * a ledger of fewer rows than that proves nothing. Timestamps are spaced at
 * whole microseconds and deliberately collide in the millisecond — that is the
 * property the keyset exists to survive, and a `now()` default would not produce
 * it reliably.
 */
export async function ensureFixtureLedger(
  client: Client,
  org: DbSpecOrg,
  minimum = 60,
): Promise<{ variantId: number }> {
  const variantId = await ensureFixtureVariant(client, org);
  const [count] = await client<{ n: string }[]>`
    SELECT count(*)::text AS n FROM inv_stock_transactions
    WHERE org_id = ${org.orgId} AND product_variant_id = ${variantId}`;
  const have = Number(count?.n ?? 0);
  if (have >= minimum) return { variantId };

  await client.begin(async (tx) => {
    for (let i = have; i < minimum; i++) {
      const micros = String(i * 100).padStart(6, "0");
      await tx`
        INSERT INTO inv_stock_transactions
          (org_id, product_variant_id, transaction_type, quantity_change,
           quantity_before, quantity_after, created_by, created_at)
        VALUES (${org.orgId}, ${variantId}, 'ADJUSTMENT_IN', 1, ${i}, ${i + 1},
                ${org.userId},
                ${`2026-01-01 00:00:00.${micros}`}::timestamp)`;
    }
  });
  return { variantId };
}

async function ensureFixtureVariant(client: Client, org: DbSpecOrg): Promise<number> {
  const sku = "DBSPEC-FIXTURE-SKU";
  const [existing] = await client<{ id: number }[]>`
    SELECT id FROM inv_product_variants WHERE org_id = ${org.orgId} AND sku = ${sku}`;
  if (existing) return Number(existing.id);

  const [product] = await client<{ id: number }[]>`
    INSERT INTO inv_products (org_id, name, sku, created_by)
    VALUES (${org.orgId}, 'db-spec fixture', ${sku}, ${org.userId})
    ON CONFLICT DO NOTHING
    RETURNING id`;
  const productId =
    product?.id ??
    Number(
      (
        await client<{ id: number }[]>`
          SELECT id FROM inv_products WHERE org_id = ${org.orgId} AND sku = ${sku}`
      )[0]!.id,
    );

  const [variant] = await client<{ id: number }[]>`
    INSERT INTO inv_product_variants (org_id, product_id, name, sku)
    VALUES (${org.orgId}, ${productId}, 'db-spec fixture', ${sku})
    RETURNING id`;
  return Number(variant!.id);
}
