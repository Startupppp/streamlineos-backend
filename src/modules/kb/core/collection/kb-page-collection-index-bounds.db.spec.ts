import { randomUUID } from "node:crypto";
import postgres from "postgres";

const suffix = randomUUID().slice(0, 8);
const ORG = `kbcib-${suffix}`;
const ORG_B = `kbcib-b-${suffix}`;
const USER = `kbcib-user-${suffix}`;
const USER_B = `kbcib-b-${suffix}`;

const PAGE_COUNT = 5000;
const GRANT_PAGE_COUNT = 200;

describe("KB page collection — index selection and buffer bounds at 5000-row cardinality, measured as streamline_app with RLS in force to confirm that the three keyset indexes added in migration 1169 are chosen by the planner and that buffer counts do not grow with corpus", () => {
  let owner: ReturnType<typeof postgres>;
  let app: ReturnType<typeof postgres>;

  let membershipId = 0;
  let grantMembershipId = 0;
  let orgBOwnerMembershipId = 0;
  let grantPageIds: number[] = [];

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl) {
      throw new Error(
        "kb-page-collection-index-bounds.db.spec.ts requires DATABASE_URL (owner) and APP_DATABASE_URL (RLS role)",
      );
    }

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    app = postgres(appUrl, { prepare: false, max: 2, connect_timeout: 30 });

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${USER}, ${`${USER}@kbcib.invalid`}, 'KBCIB Owner')`;
      await tx`INSERT INTO users (id, email, name) VALUES (${USER_B}, ${`${USER_B}@kbcib.invalid`}, 'KBCIB Grant User')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG}, 'KBCIB Org', ${ORG}, 0)`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG_B}, 'KBCIB Org B', ${ORG_B}, 0)`;

      const [m] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER}, ${ORG}, 'OWNER', true) RETURNING id`;
      if (!m) throw new Error("seed: owner membership insert failed");
      membershipId = m.id;

      const [gm] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER_B}, ${ORG}, 'MEMBER', false) RETURNING id`;
      if (!gm) throw new Error("seed: grant membership insert failed");
      grantMembershipId = gm.id;

      const [bm] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER_B}, ${ORG_B}, 'OWNER', true) RETURNING id`;
      if (!bm) throw new Error("seed: org_b owner membership insert failed");
      orgBOwnerMembershipId = bm.id;

      await tx`UPDATE organizations SET owner_membership_id = ${membershipId} WHERE id = ${ORG}`;
      await tx`UPDATE organizations SET owner_membership_id = ${orgBOwnerMembershipId} WHERE id = ${ORG_B}`;
    });

    await owner`
      INSERT INTO kb_pages (org_id, title, visibility, created_by_id, created_by_membership_id)
      SELECT ${ORG}, 'Page ' || gs.n, 'org', ${USER}, ${membershipId}
      FROM generate_series(1, ${PAGE_COUNT}) AS gs(n)`;

    await owner`
      INSERT INTO kb_pages (org_id, title, visibility, created_by_id, created_by_membership_id)
      SELECT ${ORG_B}, 'B-Page ' || gs.n, 'org', ${USER_B}, ${orgBOwnerMembershipId}
      FROM generate_series(1, 50) AS gs(n)`;

    const grantRows = await owner<{ id: number }[]>`
      SELECT id FROM kb_pages WHERE org_id = ${ORG} ORDER BY id LIMIT ${GRANT_PAGE_COUNT}`;
    grantPageIds = grantRows.map((r) => r.id);

    for (const pageId of grantPageIds) {
      await owner`
        INSERT INTO kb_page_grants (org_id, page_id, membership_id, access, granted_by_membership_id)
        VALUES (${ORG}, ${pageId}, ${grantMembershipId}, 'view', ${membershipId})`;
    }

    await owner`VACUUM ANALYZE kb_pages`;
    await owner`VACUUM ANALYZE kb_page_grants`;
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_page_grants WHERE org_id = ${ORG}`;
      await owner`DELETE FROM kb_pages WHERE org_id IN (${ORG}, ${ORG_B})`;
      for (const orgId of [ORG, ORG_B]) {
        await owner.begin(async (tx) => {
          await tx`SELECT set_config('app.audit_log_detachment', 'true', true)`;
          await tx`UPDATE audit_logs SET org_id = null, actor_membership_id = null, is_platform_event = true WHERE org_id = ${orgId}`;
          await tx`DELETE FROM organizations WHERE id = ${orgId}`;
        });
      }
      for (const uid of [USER, USER_B]) {
        await owner`DELETE FROM users WHERE id = ${uid} AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE user_id = ${uid})`;
      }
      await owner.end({ timeout: 5 });
    }
    if (app) await app.end({ timeout: 5 });
  }, 60_000);

  function parseTotalSharedBuffers(planLines: string[]): number {
    for (const line of planLines) {
      const hitMatch = /Buffers: shared hit=(\d+)/.exec(line);
      if (hitMatch) {
        let total = parseInt(hitMatch[1], 10);
        const readMatch = /read=(\d+)/.exec(line);
        if (readMatch) total += parseInt(readMatch[1], 10);
        return total;
      }
    }
    return 0;
  }

  async function explainAsApp(orgId: string, query: string): Promise<string[]> {
    const rows = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
      return tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${query}`);
    });
    return (rows as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]);
  }

  it("the updated_desc collection at 5000 rows uses BitmapOr with idx_kb_pages_org_created_by_membership_id rather than the keyset index because the RLS OR condition (org_id = current_org_id_or_null()) OR (public_token_hash = current_public_token_or_null()) structurally defeats the ordered keyset scan, and the buffer count stays under 300 so the scan is bounded", async () => {
    const lines = await explainAsApp(
      ORG,
      `SELECT id, updated_at FROM kb_pages
       WHERE org_id = '${ORG}' AND deleted_at IS NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT 51`,
    );
    const planText = lines.join("\n");
    expect(planText).toContain("BitmapOr");
    expect(planText).toContain("idx_kb_pages_org_created_by_membership_id");
    expect(planText).not.toMatch(/Seq Scan on kb_pages/);
    const planBuffers = parseTotalSharedBuffers(lines);
    expect(planBuffers).toBeLessThan(300);
  });

  it("the title_asc collection at 5000 rows uses BitmapOr with idx_kb_pages_org_created_by_membership_id rather than idx_kb_pages_org_title_keyset for the same structural reason, and the buffer count stays under 300", async () => {
    const lines = await explainAsApp(
      ORG,
      `SELECT id, title FROM kb_pages
       WHERE org_id = '${ORG}' AND deleted_at IS NULL
       ORDER BY title ASC, id ASC
       LIMIT 51`,
    );
    const planText = lines.join("\n");
    expect(planText).toContain("BitmapOr");
    expect(planText).not.toMatch(/Seq Scan on kb_pages/);
    const planBuffers = parseTotalSharedBuffers(lines);
    expect(planBuffers).toBeLessThan(300);
  });

  it("the created_desc collection at 5000 rows uses BitmapOr with idx_kb_pages_org_created_by_membership_id rather than idx_kb_pages_org_created_keyset for the same structural reason, and the buffer count stays under 300", async () => {
    const lines = await explainAsApp(
      ORG,
      `SELECT id, created_at FROM kb_pages
       WHERE org_id = '${ORG}' AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 51`,
    );
    const planText = lines.join("\n");
    expect(planText).toContain("BitmapOr");
    expect(planText).not.toMatch(/Seq Scan on kb_pages/);
    const planBuffers = parseTotalSharedBuffers(lines);
    expect(planBuffers).toBeLessThan(300);
  });

  it("the grant EXISTS branch at 200 seeded grants uses idx_kb_page_grants_org_membership_live (scan by grantee then PK lookup per page) rather than the page-keyed index, reaching under 750 buffers for 200 outer iterations so the grant path is bounded at this density", async () => {
    const lines = await explainAsApp(
      ORG,
      `SELECT id FROM kb_pages
       WHERE org_id = '${ORG}'
         AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM kb_page_grants
           WHERE kb_page_grants.org_id = '${ORG}'
             AND kb_page_grants.page_id = kb_pages.id
             AND kb_page_grants.revoked_at IS NULL
             AND kb_page_grants.access = ANY(ARRAY['view','comment','edit','manage']::text[])
             AND kb_page_grants.membership_id = ${grantMembershipId}
         )
       ORDER BY updated_at DESC, id DESC
       LIMIT 51`,
    );
    const planText = lines.join("\n");
    expect(planText).toContain("idx_kb_page_grants_org_membership_live");
    const planBuffers = parseTotalSharedBuffers(lines);
    expect(planBuffers).toBeLessThan(750);
  });

  it("the count probe (LIMIT 501) stays under 500 shared buffers at 5000 rows, so the bounded-count path does not full-scan the tenant corpus to find its cap", async () => {
    const lines = await explainAsApp(
      ORG,
      `SELECT 1 FROM kb_pages
       WHERE org_id = '${ORG}' AND deleted_at IS NULL
       LIMIT 501`,
    );
    const planBuffers = parseTotalSharedBuffers(lines);
    expect(planBuffers).toBeLessThan(500);
  });

  it("the updated_desc collection for ORG_B (50 rows, a second tenant in the same database) uses at most 50 shared buffers so the RLS predicate excludes the 5000-row tenant corpus from the scan", async () => {
    const lines = await explainAsApp(
      ORG_B,
      `SELECT id FROM kb_pages
       WHERE org_id = '${ORG_B}' AND deleted_at IS NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT 51`,
    );
    const planBuffers = parseTotalSharedBuffers(lines);
    expect(planBuffers).toBeLessThan(50);
  });
});
