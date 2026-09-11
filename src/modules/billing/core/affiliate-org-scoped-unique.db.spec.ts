/**
 * The regression net for the P1 in `AffiliateService.register`.
 *
 * `affiliates_user_id_unique` was UNIQUE(user_id) with no org_id — a bare global unique on
 * a tenant-owned table, from `.unique()` on the column in db/schema/billing/billing.ts and
 * created by migrations/0000_light_vance_astro.sql:9899. `register()` pre-checked a
 * DIFFERENT key, (org_id, user_membership_id). A user already an affiliate in org A who
 * joins org B therefore passed the pre-check, hit the global constraint on the insert,
 * and — with nothing catching 23505 — got a 500 with no diagnostic. A person could be an
 * affiliate in exactly one organisation in the entire deployment.
 *
 * Migration 1055 replaces it with uniq_affiliates_org_user (org_id, user_id), which is
 * backend/CLAUDE.md §3's rule verbatim: tenant-scoped uniqueness is composite.
 *
 * The CATALOG half is the one that matters and cannot be mocked: which columns a unique
 * constraint actually covers is a fact about Postgres, and a fake db answers whatever it
 * was told. It runs the two-organisation insert for real and rolls it back.
 *
 *   DATABASE_URL=postgresql://… \
 *     pnpm test:db-specs --testNamePattern="affiliates — real catalog"
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const DB_URL = process.env.BILLING_PROBE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DB_URL)
  throw new Error(
    "affiliate-org-scoped-unique.db.spec requires BILLING_PROBE_DATABASE_URL or DATABASE_URL",
  );

class Rollback extends Error {}

describe("affiliates — real catalog", () => {
  let client: postgres.Sql;

  beforeAll(() => {
    client = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("the deployment-global UNIQUE(user_id) is gone", async () => {
    const rows = await client<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'affiliates'::regclass AND conname = 'affiliates_user_id_unique'`;
    expect(rows).toHaveLength(0);
  });

  it("uniqueness is (org_id, user_id) in the catalog, not just in the declaration", async () => {
    const [row] = await client<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'affiliates'::regclass AND conname = 'uniq_affiliates_org_user'`;
    expect(row?.def).toBe("UNIQUE (org_id, user_id)");
  });

  it("one person can be an affiliate in two organisations, and still not twice in one", async () => {
    const tag = randomUUID().slice(0, 8);
    const userId = `p1probe-${tag}`;
    const orgA = `p1probe-a-${tag}`;
    const orgB = `p1probe-b-${tag}`;

    const observed = await client
      .begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@example.test`})`;
      for (const [org, name] of [[orgA, "A"], [orgB, "B"]] as const) {
        await tx`
          INSERT INTO organizations (id, name, slug, owner_membership_id)
          SELECT ${org}, ${name}, ${org}, max(id) + 1 FROM organization_members`;
      }
      const members: Record<string, number> = {};
      for (const org of [orgA, orgB]) {
        const [member] = await tx<Array<{ id: number }>>`
          INSERT INTO organization_members (org_id, user_id, role, status, is_owner)
          VALUES (${org}, ${userId}, 'OWNER', 'ACTIVE', true) RETURNING id`;
        members[org] = member.id;
        await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${org}`;
      }

      const insertAffiliate = (org: string, code: string) => tx`
        INSERT INTO affiliates (user_id, org_id, referral_code, user_membership_id)
        VALUES (${userId}, ${org}, ${code}, ${members[org]})`;

      await insertAffiliate(orgA, `PA${tag.toUpperCase()}`);
      // The insert that raised 23505 on affiliates_user_id_unique at journal head.
      await insertAffiliate(orgB, `PB${tag.toUpperCase()}`);

      // A savepoint, because an error aborts the enclosing transaction outright and the
      // row count below still has to be readable afterwards.
      let secondInSameOrg = "allowed";
      try {
        await tx.savepoint(async (sp) => {
          await sp`
            INSERT INTO affiliates (user_id, org_id, referral_code, user_membership_id)
            VALUES (${userId}, ${orgB}, ${`PC${tag.toUpperCase()}`}, ${members[orgB]})`;
        });
      } catch (error: unknown) {
        secondInSameOrg = String((error as { constraint_name?: string }).constraint_name);
      }

      const rows = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM affiliates WHERE user_id = ${userId}`;
      // Roll the whole fixture back rather than deleting it: a failed assertion above must
      // leave the database exactly as it was found, and `client.begin` otherwise commits.
      throw Object.assign(new Rollback(), {
        result: { affiliateRows: rows[0].n, secondInSameOrg },
      });
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (error instanceof Rollback) {
          return (error as Rollback & { result: Record<string, unknown> }).result;
        }
        throw error;
      });

    expect(observed).toEqual({ affiliateRows: 2, secondInSameOrg: "uniq_affiliates_org_user" });
  }, 30_000);

  it("leaves nothing behind", async () => {
    const [row] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM affiliates WHERE user_id LIKE 'p1probe-%'`;
    expect(row?.n).toBe(0);
  });
});
