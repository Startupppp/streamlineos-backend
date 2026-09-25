import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { kbPages } from "../../../db/schema";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { buildArticleRestrictionBranch } from "../core/authorization/knowledge-page-scope";

const suffix = randomUUID().slice(0, 8);
const ORG = `kbrestr-${suffix}`;
const PROBE_USER = `kbrestr-user-${suffix}`;
const ROLE_A = `KBRESTR_A_${suffix.toUpperCase()}`;
const ROLE_B = `KBRESTR_B_${suffix.toUpperCase()}`;

describe("KB article restriction filter binds role slugs as an array", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let base: ReturnType<typeof drizzle<typeof schema>>;
  let membershipId = 0;
  let openArticleId = 0;
  let roleArticleId = 0;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error("kb-article-restriction-role-binding.db.spec.ts requires DATABASE_URL (owner) and APP_DATABASE_URL (RLS role)");

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, { prepare: false, max: 2, connect_timeout: 30 });
    base = drizzle(appClient, { schema });

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${PROBE_USER}, ${`${PROBE_USER}@kb-restr.invalid`}, 'KB restriction probe')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG}, 'KB restriction probe', ${ORG}, 0)`;
      const [member] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${PROBE_USER}, ${ORG}, 'OWNER', true) RETURNING id`;
      if (!member) throw new Error("seed: membership insert failed");
      membershipId = member.id;
      await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${ORG}`;
    });

    const [open] = await owner<{ id: number }[]>`
      INSERT INTO kb_pages (org_id, title, slug, status, content_type)
      VALUES (${ORG}, 'Open handbook', ${`open-${suffix}`}, 'published', 'support_article') RETURNING id`;
    const [restricted] = await owner<{ id: number }[]>`
      INSERT INTO kb_pages (org_id, title, slug, status, content_type)
      VALUES (${ORG}, 'Role handbook', ${`role-${suffix}`}, 'published', 'support_article') RETURNING id`;
    if (!open || !restricted) throw new Error("seed: article insert failed");
    openArticleId = open.id;
    roleArticleId = restricted.id;

    await owner`
      INSERT INTO kb_page_restrictions (org_id, page_id, role, level)
      VALUES (${ORG}, ${roleArticleId}, ${ROLE_A}, 'view')`;
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_page_restrictions WHERE org_id = ${ORG}`;
      await owner`DELETE FROM kb_pages WHERE org_id = ${ORG}`;
      await owner`DELETE FROM organizations WHERE id = ${ORG}`;
      await owner`DELETE FROM users WHERE id = ${PROBE_USER}`;
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  async function visibleArticleIds(roleSlugs: string[]): Promise<number[]> {
    return base.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.organization_id', ${ORG}, true)`);
      return runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx }, async () => {
        const rows = await tx
          .select({ id: kbPages.id })
          .from(kbPages)
          .where(
            and(
              eq(kbPages.orgId, ORG),
              inArray(kbPages.id, [openArticleId, roleArticleId]),
              buildArticleRestrictionBranch(ORG, {
                membershipId,
                roleSlugs,
              }),
            ),
          );
        return rows.map((row) => row.id).sort((a, b) => a - b);
      });
    });
  }

  it("executes and matches with ONE role slug — the arity that produced a malformed array literal", async () => {
    await expect(visibleArticleIds([ROLE_A])).resolves.toEqual(
      [openArticleId, roleArticleId].sort((a, b) => a - b),
    );
  }, 60_000);

  it("executes with TWO role slugs — the arity that produced ANY/ALL requires array on right side", async () => {
    await expect(visibleArticleIds([ROLE_A, ROLE_B])).resolves.toEqual(
      [openArticleId, roleArticleId].sort((a, b) => a - b),
    );
  }, 60_000);

  it("still hides a role-restricted article from a holder of a different role", async () => {
    await expect(visibleArticleIds([ROLE_B])).resolves.toEqual([openArticleId]);
  }, 60_000);

  it("still hides it from a principal with no roles at all", async () => {
    await expect(visibleArticleIds([])).resolves.toEqual([openArticleId]);
  }, 60_000);
});
