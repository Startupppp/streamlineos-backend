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
