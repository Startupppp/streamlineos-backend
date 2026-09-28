import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

const suffix = randomUUID().slice(0, 8);
const ORG = `kbcib-${suffix}`;
const ORG_B = `kbcib-b-${suffix}`;
const ORG_BULK = `kbcib-bulk-${suffix}`;
const USER = `kbcib-user-${suffix}`;
const USER_B = `kbcib-b-${suffix}`;

const PAGE_COUNT = 5000;
const BULK_PAGE_COUNT = 20000;
const GRANT_PAGE_COUNT = 200;

const SHARED_TOKEN = `kbcib-token-${suffix}`;
const SHARED_TOKEN_HASH = createHash("sha256")
  .update(SHARED_TOKEN)
  .digest("hex");
const ABSENT_TOKEN_HASH = createHash("sha256")
  .update(`${SHARED_TOKEN}-absent`)
  .digest("hex");

describe("KB page collection — index selection and buffer bounds at 5000-row cardinality, measured as streamline_app with RLS in force, pinning that migration 1169's three keyset indexes are usable as ordered scans under the migration 1171 policy and that the planner's choice between them and the BitmapOr turns on a row estimate the policy double-counts", () => {
  let owner: ReturnType<typeof postgres>;
  let app: ReturnType<typeof postgres>;

  let membershipId = 0;
  let grantMembershipId = 0;
  let orgBOwnerMembershipId = 0;
  let bulkOwnerMembershipId = 0;
  let grantPageIds: number[] = [];
  let sharedPageId = 0;
  let orgShareOfTable = 0;

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
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG_BULK}, 'KBCIB Org Bulk', ${ORG_BULK}, 0)`;

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

      const [km] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER}, ${ORG_BULK}, 'OWNER', true) RETURNING id`;
      if (!km) throw new Error("seed: bulk owner membership insert failed");
      bulkOwnerMembershipId = km.id;

      await tx`UPDATE organizations SET owner_membership_id = ${membershipId} WHERE id = ${ORG}`;
      await tx`UPDATE organizations SET owner_membership_id = ${orgBOwnerMembershipId} WHERE id = ${ORG_B}`;
      await tx`UPDATE organizations SET owner_membership_id = ${bulkOwnerMembershipId} WHERE id = ${ORG_BULK}`;
    });

    await owner`
      INSERT INTO kb_pages (org_id, title, visibility, created_by_id, created_by_membership_id)
      SELECT ${ORG}, 'Page ' || gs.n, 'org', ${USER}, ${membershipId}
      FROM generate_series(1, ${PAGE_COUNT}) AS gs(n)`;

    await owner`
      INSERT INTO kb_pages (org_id, title, visibility, created_by_id, created_by_membership_id)
      SELECT ${ORG_B}, 'B-Page ' || gs.n, 'org', ${USER_B}, ${orgBOwnerMembershipId}
      FROM generate_series(1, 50) AS gs(n)`;

    await owner`
      INSERT INTO kb_pages (org_id, title, visibility, created_by_id, created_by_membership_id)
      SELECT ${ORG_BULK}, 'Bulk Page ' || gs.n, 'org', ${USER}, ${bulkOwnerMembershipId}
      FROM generate_series(1, ${BULK_PAGE_COUNT}) AS gs(n)`;

    const grantRows = await owner<{ id: number }[]>`
      SELECT id FROM kb_pages WHERE org_id = ${ORG} ORDER BY id LIMIT ${GRANT_PAGE_COUNT}`;
    grantPageIds = grantRows.map((r) => r.id);

    for (const pageId of grantPageIds) {
      await owner`
        INSERT INTO kb_page_grants (org_id, page_id, membership_id, access, granted_by_membership_id)
        VALUES (${ORG}, ${pageId}, ${grantMembershipId}, 'view', ${membershipId})`;
    }

    const [sharedRow] = await owner<{ id: number }[]>`
      SELECT id FROM kb_pages WHERE org_id = ${ORG} ORDER BY id DESC LIMIT 1`;
    if (!sharedRow) throw new Error("seed: shared page select failed");
    sharedPageId = sharedRow.id;
    await owner`
      UPDATE kb_pages
         SET public_token = ${SHARED_TOKEN}, public_token_hash = ${SHARED_TOKEN_HASH}
       WHERE id = ${sharedPageId}`;

    await owner`VACUUM ANALYZE kb_pages`;
    await owner`VACUUM ANALYZE kb_page_grants`;

    const [share] = await owner<{ org_rows: string; all_rows: string }[]>`
      SELECT count(*) FILTER (WHERE org_id = ${ORG})::text AS org_rows,
             count(*)::text AS all_rows
        FROM kb_pages`;
    if (!share) throw new Error("seed: share measurement failed");
    orgShareOfTable = Number(share.org_rows) / Number(share.all_rows);
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_page_grants WHERE org_id = ${ORG}`;
      await owner`DELETE FROM kb_pages WHERE org_id IN (${ORG}, ${ORG_B}, ${ORG_BULK})`;
      for (const orgId of [ORG, ORG_B, ORG_BULK]) {
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

  function parsePlannedRows(planLines: string[]): number {
    for (const line of planLines) {
      const match = /rows=(\d+)/.exec(line);
      if (match) return parseInt(match[1], 10);
    }
    return 0;
  }

  function parseActualRowsOf(planLines: string[], node: string): number {
    for (const line of planLines) {
      if (!line.includes(node)) continue;
      const match = /actual (?:time=[\d.]+\.\.[\d.]+ )?rows=([\d.]+)/.exec(line);
      if (match) return Math.round(parseFloat(match[1]));
    }
    return -1;
  }

  function hasSortNode(planLines: string[]): boolean {
    return planLines.some((line) => /\bSort\s+\(cost=/.test(line));
  }

  async function explainAsApp(
    orgId: string,
    query: string,
    plannerSettings: readonly string[] = [],
  ): Promise<string[]> {
    const rows = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
      for (const setting of plannerSettings) {
        await tx.unsafe(`SET LOCAL ${setting}`);
      }
      return tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN (ANALYZE, BUFFERS) ${query}`,
      );
    });
    return rows.map((r) => r["QUERY PLAN"]);
  }

  async function explainAsOwner(query: string): Promise<string[]> {
    const rows = await owner.unsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN ${query}`,
    );
    return rows.map((r) => r["QUERY PLAN"]);
  }

  async function readAsApp(
    gucs: Readonly<Record<string, string>>,
    query: string,
  ): Promise<number[]> {
    const rows = await app.begin(async (tx) => {
      for (const [name, value] of Object.entries(gucs)) {
        await tx`SELECT set_config(${name}, ${value}, true)`;
      }
      return tx.unsafe<{ id: number }[]>(query);
    });
    return rows.map((r) => r.id);
  }

  const SORT_VARIANTS = [
    {
      label: "updated_desc",
      projection: "id, updated_at",
      order: "updated_at DESC, id DESC",
      keysetIndex: "idx_kb_pages_org_updated_keyset",
    },
    {
      label: "title_asc",
      projection: "id, title",
      order: "title ASC, id ASC",
      keysetIndex: "idx_kb_pages_org_title_keyset",
    },
    {
      label: "created_desc",
      projection: "id, created_at",
      order: "created_at DESC, id DESC",
      keysetIndex: "idx_kb_pages_org_created_keyset",
    },
  ] as const;

  function collectionQuery(variant: (typeof SORT_VARIANTS)[number]): string {
    return `SELECT ${variant.projection} FROM kb_pages
       WHERE org_id = '${ORG}' AND deleted_at IS NULL
       ORDER BY ${variant.order}
       LIMIT 51`;
  }

  it.each(SORT_VARIANTS)(
    "the $label collection at 5000 rows promotes the application's own org_id equality into an index condition even though the RLS policy is a security-barrier qual, because texteq is leakproof and is therefore securely promotable, and the scan stays under 300 shared buffers without ever falling back to a sequential scan",
    async (variant) => {
      const lines = await explainAsApp(ORG, collectionQuery(variant));
      const planText = lines.join("\n");
      expect(
        lines.some(
          (line) =>
            line.includes("Index Cond:") &&
            line.includes(`org_id = '${ORG}'::text`),
        ),
      ).toBe(true);
      expect(planText).toContain("current_org_id_or_null()");
      expect(planText).toContain("current_public_token_or_null()");
      expect(planText).not.toMatch(/Seq Scan on kb_pages/);
      const planBuffers = parseTotalSharedBuffers(lines);
      expect(planBuffers).toBeLessThan(300);
    },
  );

  it.each(SORT_VARIANTS)(
    "the $label collection can be served by $keysetIndex as an ordered index scan with no Sort node once the bitmap path is removed, which refutes the claim that the RLS OR structurally denies an ordered keyset scan — the BitmapOr is a cost choice the planner makes, not a plan the policy forces",
    async (variant) => {
      const lines = await explainAsApp(ORG, collectionQuery(variant), [
        "enable_bitmapscan = off",
      ]);
      const planText = lines.join("\n");
      expect(planText).toContain(`Index Scan using ${variant.keysetIndex}`);
      expect(hasSortNode(lines)).toBe(false);
      expect(planText).not.toMatch(/Seq Scan on kb_pages/);
      expect(parseTotalSharedBuffers(lines)).toBeLessThan(300);
    },
  );

  it("the RLS policy's org_id branch is counted a second time on top of the application's own org_id equality, so the row estimate streamline_app plans against is the tenant's share of kb_pages multiplied into the estimate the BYPASSRLS owner sees — this f-squared underestimate, not the OR itself, is what makes the BitmapOr plus top-N sort look cheaper than the ordered keyset scan", async () => {
    const countQuery = `SELECT id FROM kb_pages WHERE org_id = '${ORG}' AND deleted_at IS NULL`;
    const ownerEstimate = parsePlannedRows(await explainAsOwner(countQuery));
    const appEstimate = parsePlannedRows(await explainAsApp(ORG, countQuery));

    expect(ownerEstimate).toBeGreaterThan(PAGE_COUNT / 2);
    expect(orgShareOfTable).toBeLessThan(0.5);

    const doubleCounted = ownerEstimate * orgShareOfTable;
    expect(appEstimate).toBeLessThan(ownerEstimate / 2);
    expect(appEstimate).toBeGreaterThan(doubleCounted / 3);
    expect(appEstimate).toBeLessThan(doubleCounted * 3);
  });

  it("the BitmapOr plan the underestimate selects materialises the whole tenant corpus before the top-N sort, so a 51-row collection page costs a scan proportional to the tenant's page count rather than to the page size — this is the unbounded read the keyset indexes were added to remove", async () => {
    const lines = await explainAsApp(ORG, collectionQuery(SORT_VARIANTS[0]), [
      "enable_indexscan = off",
      "enable_indexonlyscan = off",
    ]);
    const planText = lines.join("\n");
    expect(planText).toContain("BitmapOr");
    expect(hasSortNode(lines)).toBe(true);
    expect(parseActualRowsOf(lines, "Bitmap Heap Scan on kb_pages")).toBe(
      PAGE_COUNT,
    );
  });

  it("the tenant_isolation policy admits exactly three visibility states under streamline_app — a tenant GUC sees that tenant's pages and none of the second tenant's, a public token hash with no tenant GUC sees exactly the one shared page, and an unknown token or no context at all sees nothing — so any policy rewrite that keeps the ordered scan must reproduce all three", async () => {
    const tenantRows = await readAsApp(
      { "app.organization_id": ORG },
      `SELECT id FROM kb_pages WHERE deleted_at IS NULL`,
    );
    expect(tenantRows.length).toBe(PAGE_COUNT);
    expect(tenantRows).toContain(sharedPageId);

    const otherTenantRows = await readAsApp(
      { "app.organization_id": ORG_B },
      `SELECT id FROM kb_pages WHERE id = ${sharedPageId}`,
    );
    expect(otherTenantRows).toEqual([]);

    const tokenRows = await readAsApp(
      { "app.public_token": SHARED_TOKEN_HASH },
      `SELECT id FROM kb_pages WHERE deleted_at IS NULL`,
    );
    expect(tokenRows).toEqual([sharedPageId]);

    const wrongTokenRows = await readAsApp(
      { "app.public_token": ABSENT_TOKEN_HASH },
      `SELECT id FROM kb_pages WHERE deleted_at IS NULL`,
    );
    expect(wrongTokenRows).toEqual([]);

    const noContextRows = await readAsApp(
      {},
      `SELECT id FROM kb_pages WHERE id = ${sharedPageId}`,
    );
    expect(noContextRows).toEqual([]);
  });

  it("the public token read reaches the shared page through uniq_kb_pages_public_token_hash on the application's own public_token_hash equality rather than through the RLS branch, so the policy's token branch never has to be index-visible for the public share path to stay bounded", async () => {
    const lines = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.public_token', ${SHARED_TOKEN_HASH}, true)`;
      const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT id, title FROM kb_pages
           WHERE public_token_hash = '${SHARED_TOKEN_HASH}' AND deleted_at IS NULL`,
      );
      return rows.map((r) => r["QUERY PLAN"]);
    });
    const planText = lines.join("\n");
    expect(planText).toContain(
      "Index Scan using uniq_kb_pages_public_token_hash",
    );
    expect(planText).not.toMatch(/Seq Scan on kb_pages/);
    expect(parseTotalSharedBuffers(lines)).toBeLessThan(50);
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
