/**
 * `POST /kb/pages/reindex-all` must not hold the request transaction across 100 embeddings —
 * and taking the transaction away must not simply move the failure.
 *
 * WHAT WAS WRONG. Neither reindex handler carried `@NoTenantTransaction()`, so both ran inside
 * the transaction `TenantContextInterceptor` opens, against the 60s
 * `idle_in_transaction_session_timeout` `withTenant` sets. `reindexAllPages` loops
 * `for (const page of batch) await this.indexPage(...)` with `REINDEX_ALL_BATCH_SIZE = 100`, and
 * every `indexPage` awaits an embedding round trip. Ten to sixty seconds into a real tenant's
 * reindex the timeout kills the transaction with the pooled connection still checked out
 * mid-embed, and every embedding already issued has already been billed.
 *
 * WHY THE OBVIOUS FIX IS HALF A FIX, AND NOT IN THE WAY IT LOOKS. Without an ambient context
 * `createTenantAwareDb` falls through to the pool, which carries no tenant GUC. `kb_pages` has
 * `relrowsecurity = true`, and its policy — read from `pg_policy`, not assumed — is
 * `(org_id = app.current_org_id_or_null()) OR (public_token = app.current_public_token_or_null())`.
 * The `_or_null` variant RETURNS NULL where `app.current_org_id()` raises `42501`, so the bare
 * listing at the top of `reindexAllPages` would not have failed loudly: it would have matched
 * nothing and answered `{"reindexed":0,"nextPageId":null}` for a tenant with a thousand pages.
 * An admin would press Reindex All, see success, and reindex nothing. (`kb_article_chunks` is
 * the other way round — its policy uses the raising variant — so the same mistake on a
 * different table fails loudly. That difference is exactly why this is measured, not reasoned.)
 * The listing is now wrapped in `runInTenantTransaction(..., { orgId })`, which is what makes
 * the decorator safe.
 *
 * Run with:
 *   APP_DATABASE_URL="postgresql://streamline_app:…@localhost:5432/scratch_head_1010" \
 *   DATABASE_URL="postgresql://tarunchintakunta@localhost:5432/scratch_head_1010" \
 *   PGSSLMODE=disable \
 *   pnpm test:db-specs --testPathPattern="kb-page-reindex-placement.db"
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { kbPages } from "../../../db/schema";
import { createTenantAwareDb } from "../../../common/tenant/tenant-db";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const suffix = randomUUID().slice(0, 8);
const ORG = `kbrix-${suffix}`;
const PROBE_USER = `kbrix-user-${suffix}`;

describe("KB reindex listing supplies its own tenant context", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let appDb: ReturnType<typeof createTenantAwareDb>;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error("DATABASE_URL (owner, seeds) and APP_DATABASE_URL (RLS role) are required");

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appDb = createTenantAwareDb(Object.assign(drizzle(appClient, { schema }), { __client: appClient }));

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${PROBE_USER}, ${`${PROBE_USER}@kb-rix.invalid`}, 'KB reindex probe')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG}, 'KB reindex probe', ${ORG}, 0)`;
      const [member] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${PROBE_USER}, ${ORG}, 'OWNER', true) RETURNING id`;
      await tx`UPDATE organizations SET owner_membership_id = ${member?.id} WHERE id = ${ORG}`;
    });

    await owner`
      INSERT INTO kb_pages (org_id, title, content, content_text, status, visibility)
      VALUES (${ORG}, 'Reindex probe', '{}'::jsonb, 'body', 'published', 'org')`;
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_pages WHERE org_id = ${ORG}`;
      await owner`DELETE FROM organizations WHERE id = ${ORG}`;
      await owner`DELETE FROM users WHERE id = ${PROBE_USER}`;
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  const livePages = and(
    eq(kbPages.orgId, ORG),
    gt(kbPages.id, 0),
    ne(kbPages.status, "archived"),
    isNull(kbPages.deletedAt),
  );

  it("the unwrapped listing — what @NoTenantTransaction alone would have left — silently sees nothing", async () => {
    const unscoped = await appDb
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(livePages)
      .orderBy(asc(kbPages.id))
      .limit(101);
    expect(unscoped).toEqual([]);

    const [seeded] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kb_pages WHERE org_id = ${ORG} AND deleted_at IS NULL`;
    expect(seeded?.n).toBeGreaterThan(0);
  }, 120_000);

  it("the wrapped listing opens its own transaction and returns the tenant's pages", async () => {
    const rows = await runInTenantTransaction(
      appDb,
      async (tx) =>
        tx
          .select({ id: kbPages.id, orgId: kbPages.orgId })
          .from(kbPages)
          .where(livePages)
          .orderBy(asc(kbPages.id))
          .limit(101),
      { orgId: ORG },
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orgId === ORG)).toBe(true);
  }, 120_000);
});
