import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const poolerUrl = process.env.DATABASE_URL;
if (!poolerUrl) {
  console.error("DATABASE_URL is required in .env");
  process.exit(1);
}

// SET ROLE needs a session-mode connection; Neon encodes that in the host
const adminUrl =
  process.env.DIRECT_DATABASE_URL ||
  (/-pooler\..*\.neon\.tech/i.test(poolerUrl) ? poolerUrl.replace("-pooler.", ".") : poolerUrl);

const PROBE_ROLE = "rls_probe_role";
const PROBE_TABLE = "rls_probe";
// Second probe with a NULLABLE tenant column. Platform-level rows (sign-in OTP
// -> email_outbox) are written with no org and no tenant context, and that path
// was broken for every nullable-tenant table until 0380 because WITH CHECK
// called the raising helper unconditionally. Probing only a NOT NULL table is
// what let that ship.
const PROBE_TABLE_NULLABLE = "rls_probe_nullable";

const sql = postgres(adminUrl, { prepare: false, max: 1, onnotice: () => {} });
let failures = 0;

// Scope classification. CRM and Inventory are out of this release's scope
// (PRD-IN-SCOPE.md). They are excluded BY NAME into their own reported bucket, never
// folded into a silent ignore, and an unrecognised table classifies as IN-SCOPE so a
// new table without a policy fails rather than slipping through as excluded.
// The name sets match check-tenant-relationships.mjs so the two gates cannot disagree.
const CRM_TABLE_NAMES = new Set([
  "clients", "leads", "deals", "contacts", "quotes", "pipelines", "pipeline_stages",
  "activities", "campaigns", "campaign_recipients", "quote_items", "contact_notes",
  "contact_tags", "deal_activities", "deal_approvals", "deal_meetings",
  "lead_activities", "lead_emails", "lead_notes", "lead_tasks",
  "enterprise_quotes", "client_accounts", "client_onboarding_items",
  "client_opportunities", "commissions", "csat_surveys", "quote_line_items",
  "vendor_credits", "credit_notes",
]);
function bareName(qualified) {
  return qualified.includes(".") ? qualified.slice(qualified.indexOf(".") + 1) : qualified;
}
function isCrmTable(qualified) {
  const n = bareName(qualified);
  return n.startsWith("crm_") || CRM_TABLE_NAMES.has(n);
}
function isInvTable(qualified) {
  const n = bareName(qualified);
  return n.startsWith("inv_") || n === "inv_items";
}
const buckets = { inScopeCovered: 0, inScopeMissing: [], platformGlobal: [], crm: [], inventory: [] };
function classifyTable(tbl) {
  if (PLATFORM_GLOBAL_TABLES.has(tbl)) return "PLATFORM-GLOBAL";
  if (isCrmTable(tbl)) return "EXCLUDED: CRM";
  if (isInvTable(tbl)) return "EXCLUDED: INVENTORY";
  return "IN-SCOPE";
}

const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

// Tables that intentionally carry an org_id column without per-tenant RLS.
// Each entry must be justified: if the table is a legitimate platform-global
// table (e.g. it IS the org row itself) its name goes here with a brief rationale
// embedded in the source comment. Absence from this list is treated as a gap,
// not as "global by default" — ALTER DEFAULT PRIVILEGES grants SELECT to the app
// role on every new table, so a missing policy is a silent cross-tenant read hole.
//
// Format: "schema.tablename"
// An empty set means every tenant-column table must be RLS-protected.
const PLATFORM_GLOBAL_TABLES = new Set([
  // "public.organizations" — the tenant row itself; RLS would use org_id = app.current_org_id()
  //   but the org row has no foreign org_id column referencing itself.  Access is
  //   controlled by application-layer membership checks, not row-level policy.
  //   Owner: identity/auth module.

  // Control-plane routing and lifecycle state (c28 Phase 1). Each of these is read or
  // written with NO tenant GUC set, because it necessarily runs before a tenant context
  // exists — so a policy predicated on app.current_org_id() would make the operation
  // impossible rather than safe. None is reachable from a tenant-facing endpoint.
  // Owner: platform/placement.

  // Read by RegionRegistry before any transaction opens, to decide which database the
  // transaction should open on. A policy here would deadlock routing against itself.
  "public.organization_placement",

  // Written by the CREATE saga before the cell's organization row exists, and read by
  // resumption after a crash with no request context at all.
  "public.organization_lifecycle_sagas",
  "public.organization_saga_steps",

  // Global uniqueness reservations for slug, domain and organization id. Their whole
  // purpose is to be unique ACROSS tenants, which a per-tenant policy would defeat.
  "public.organization_reservations",

  // Control-plane relocation and placement decisions (c28 Phases 3-4). A relocation row
  // is written while the organization is being moved between cells, so it must be
  // readable and writable in the control plane with no tenant GUC — the tenant's own
  // connection is precisely the one being fenced. Read only by operator scripts and the
  // placement selector; no tenant-facing endpoint reaches them.
  "public.organization_relocations",
  "public.organization_relocation_checksums",
  "public.placement_decisions",
  "public.noisy_neighbour_reviews",
]);


const teardown = `
  DROP TABLE IF EXISTS public.${PROBE_TABLE};
  DROP TABLE IF EXISTS public.${PROBE_TABLE_NULLABLE};
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
      EXECUTE 'REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}';
      EXECUTE 'REVOKE ALL ON SCHEMA app FROM ${PROBE_ROLE}';
      EXECUTE 'REVOKE ALL ON FUNCTION app.current_org_id() FROM ${PROBE_ROLE}';
      EXECUTE 'DROP ROLE ${PROBE_ROLE}';
    END IF;
  END $$;`;

try {
  const [{ n: helper }] = await sql`
    SELECT count(*)::int n FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'app' AND p.proname = 'current_org_id'`;
  if (helper === 0) {
    console.error("app.current_org_id() is missing — run `pnpm db:bootstrap` first.");
    process.exit(1);
  }

  await sql.unsafe(teardown);
  // A disposable non-owner, non-BYPASSRLS role stands in for the real app role,
  // so isolation can be proven before the app role's password is provisioned.
  await sql.unsafe(`
    CREATE ROLE ${PROBE_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT ${PROBE_ROLE} TO CURRENT_USER WITH SET TRUE;
    CREATE TABLE public.${PROBE_TABLE} (id serial primary key, org_id text NOT NULL, note text);
    INSERT INTO public.${PROBE_TABLE} (org_id, note) VALUES
      ('org-A','a1'),('org-A','a2'),('org-A','a3'),('org-B','b1'),('org-B','b2');
    GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE};
    GRANT USAGE ON SCHEMA app TO ${PROBE_ROLE};
    GRANT EXECUTE ON FUNCTION app.current_org_id() TO ${PROBE_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.${PROBE_TABLE} TO ${PROBE_ROLE};
    GRANT USAGE, SELECT ON SEQUENCE public.${PROBE_TABLE}_id_seq TO ${PROBE_ROLE};
    ALTER TABLE public.${PROBE_TABLE} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON public.${PROBE_TABLE} FOR ALL
      USING (org_id = app.current_org_id())
      WITH CHECK (org_id = app.current_org_id());

    CREATE TABLE public.${PROBE_TABLE_NULLABLE} (id serial primary key, org_id text, note text);
    INSERT INTO public.${PROBE_TABLE_NULLABLE} (org_id, note) VALUES
      ('org-A','a1'),('org-B','b1'),(NULL,'platform');
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.${PROBE_TABLE_NULLABLE} TO ${PROBE_ROLE};
    GRANT USAGE, SELECT ON SEQUENCE public.${PROBE_TABLE_NULLABLE}_id_seq TO ${PROBE_ROLE};
    ALTER TABLE public.${PROBE_TABLE_NULLABLE} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON public.${PROBE_TABLE_NULLABLE} FOR ALL
      USING (CASE WHEN org_id IS NULL THEN true ELSE org_id = app.current_org_id() END)
      WITH CHECK (CASE WHEN org_id IS NULL THEN true ELSE org_id = app.current_org_id() END);
  `);

  const asTenant = (org, fn) =>
    sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
      if (org) await tx`SELECT set_config('app.organization_id', ${org}, true)`;
      return fn(tx);
    });
  const countAs = (org) =>
    asTenant(org, async (tx) => (await tx`SELECT count(*)::int n FROM rls_probe`)[0].n);

  check(
    "migration role still unrestricted (BYPASSRLS)",
    (await sql`SELECT count(*)::int n FROM rls_probe`)[0].n === 5,
  );
  check("tenant A reads only its own rows", (await countAs("org-A")) === 3);
  check("tenant B reads only its own rows", (await countAs("org-B")) === 2);
  check("unknown tenant reads nothing", (await countAs("org-missing")) === 0);

  try {
    await asTenant(null, (tx) => tx`SELECT count(*) FROM rls_probe`);
    check("query with no tenant context is rejected", false, "it returned rows");
  } catch (err) {
    check("query with no tenant context is rejected", /no tenant context/.test(String(err.message)));
  }

  try {
    await asTenant("org-A", (tx) => tx`INSERT INTO rls_probe (org_id, note) VALUES ('org-B','x')`);
    check("cross-tenant INSERT is blocked", false, "it was allowed");
  } catch (err) {
    check("cross-tenant INSERT is blocked", /row-level security/i.test(String(err.message)));
  }

  check(
    "cross-tenant UPDATE touches nothing",
    (await asTenant("org-A", async (tx) =>
      (await tx`UPDATE rls_probe SET note='x' WHERE org_id='org-B' RETURNING id`).length)) === 0,
  );
  check(
    "cross-tenant DELETE touches nothing",
    (await asTenant("org-A", async (tx) =>
      (await tx`DELETE FROM rls_probe WHERE org_id='org-B' RETURNING id`).length)) === 0,
  );
  check(
    "own-tenant INSERT still succeeds",
    (await asTenant("org-A", async (tx) =>
      (await tx`INSERT INTO rls_probe (org_id, note) VALUES ('org-A','ok') RETURNING id`).length)) === 1,
  );
  check(
    "the other tenant's rows are intact",
    (await sql`SELECT count(*)::int n FROM rls_probe WHERE org_id='org-B'`)[0].n === 2,
  );

  // Nullable tenant column — the platform-level write path (sign-in OTP).
  // This is the regression 0380 fixed: WITH CHECK called app.current_org_id()
  // unconditionally, so a NULL-tenant insert with no tenant context raised
  // 42501 and no sign-in email was ever queued.
  check(
    "platform-level INSERT succeeds with no tenant context",
    (await asTenant(null, async (tx) =>
      (await tx`INSERT INTO rls_probe_nullable (org_id, note) VALUES (NULL,'otp') RETURNING id`)
        .length)) === 1,
  );
  check(
    "platform-level INSERT succeeds inside a tenant transaction",
    (await asTenant("org-A", async (tx) =>
      (await tx`INSERT INTO rls_probe_nullable (org_id, note) VALUES (NULL,'otp2') RETURNING id`)
        .length)) === 1,
  );
  check(
    "own-tenant INSERT still succeeds on a nullable tenant column",
    (await asTenant("org-A", async (tx) =>
      (await tx`INSERT INTO rls_probe_nullable (org_id, note) VALUES ('org-A','ok') RETURNING id`)
        .length)) === 1,
  );

  try {
    await asTenant("org-A", (tx) =>
      tx`INSERT INTO rls_probe_nullable (org_id, note) VALUES ('org-B','x')`);
    check("cross-tenant INSERT is blocked on a nullable tenant column", false, "it was allowed");
  } catch (err) {
    check(
      "cross-tenant INSERT is blocked on a nullable tenant column",
      /row-level security/i.test(String(err.message)),
    );
  }

  check(
    "tenant does not see the other tenant's rows on a nullable tenant column",
    (await asTenant("org-A", async (tx) =>
      (await tx`SELECT count(*)::int n FROM rls_probe_nullable WHERE org_id='org-B'`)[0].n)) === 0,
  );

  // The property the pooler makes or breaks: a tenant id must not outlive its transaction
  await sql.begin((tx) => tx`SELECT set_config('app.organization_id', 'org-LEAK', true)`);
  const [{ v: leaked }] = await sql`SELECT current_setting('app.organization_id', true) AS v`;
  check("tenant id does not survive COMMIT", !leaked, leaked ? `leaked "${leaked}"` : "");

} finally {
  await sql.unsafe(teardown).catch((err) => console.error("teardown:", err.message));
  const [{ n: roleLeft }] = await sql`SELECT count(*)::int n FROM pg_roles WHERE rolname=${PROBE_ROLE}`;
  const [{ n: tableLeft }] = await sql`
    SELECT count(*)::int n FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN (${PROBE_TABLE}, ${PROBE_TABLE_NULLABLE})`;
  if (roleLeft || tableLeft) {
    failures++;
    console.error(`teardown incomplete: role=${roleLeft} table=${tableLeft}`);
  }
  const [coverage] = await sql`
    SELECT
      (SELECT count(DISTINCT c.oid)::int FROM pg_class c
        JOIN pg_namespace n2 ON n2.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n2.nspname IN ('public','build','build_events') AND c.relkind='r'
          AND a.attname IN ('org_id','organization_id')
          AND format_type(a.atttypid, NULL)='text') AS tenant_columns,
      (SELECT count(*)::int FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','build','build_events') AND c.relrowsecurity) AS rls_enabled`;
  console.log(
    `
coverage: ${coverage.rls_enabled} of ${coverage.tenant_columns} tenant-scoped tables have RLS enabled`,
  );

  // 1. Tables with an org_id column that have no RLS enabled at all.
  //    Every such table is a potential cross-tenant read hole because ALTER DEFAULT
  //    PRIVILEGES grants SELECT to the app role on every new table.
  const unprotected = await sql`
    SELECT DISTINCT n.nspname || '.' || c.relname AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname IN ('public','build','build_events')
      AND c.relkind = 'r'
      AND a.attname IN ('org_id','organization_id')
      AND format_type(a.atttypid, NULL) = 'text'
      AND NOT c.relrowsecurity
    ORDER BY tbl`;

  for (const { tbl } of unprotected) {
    const bucket = classifyTable(tbl);
    if (bucket === "PLATFORM-GLOBAL") { buckets.platformGlobal.push(tbl); continue; }
    if (bucket === "EXCLUDED: CRM") { buckets.crm.push(tbl); continue; }
    if (bucket === "EXCLUDED: INVENTORY") { buckets.inventory.push(tbl); continue; }
    buckets.inScopeMissing.push(tbl);
    check(`RLS enabled on ${tbl}`, false, "in-scope tenant table has no RLS — add a policy or register in PLATFORM_GLOBAL_TABLES");
  }
  buckets.inScopeCovered = coverage.tenant_columns - buckets.inScopeMissing.length -
    buckets.platformGlobal.length - buckets.crm.length - buckets.inventory.length;
  console.log(
    `
BUCKET SUMMARY  (${coverage.tenant_columns} tenant-scoped tables scanned)` +
    `
  IN-SCOPE COVERED:    ${buckets.inScopeCovered}` +
    `
  IN-SCOPE MISSING:    ${buckets.inScopeMissing.length}` +
    `
  PLATFORM-GLOBAL:     ${buckets.platformGlobal.length}` +
    `
  EXCLUDED: CRM:       ${buckets.crm.length}` +
    `
  EXCLUDED: INVENTORY: ${buckets.inventory.length}`);
  for (const t of buckets.inventory) console.log(`  excluded  ${t} — Inventory is out of release scope`);
  for (const t of buckets.crm) console.log(`  excluded  ${t} — CRM is out of release scope`);
  for (const t of buckets.platformGlobal) console.log(`  skip      ${t} — registered platform-global`);

  // 2. Tables that have RLS enabled and an org_id column but lack any policy that
  //    references the org column.  An empty policy set leaves the table readable by
  //    no one (deny-by-default), which is safe but almost certainly wrong for a
  //    business table; a policy with the wrong predicate (e.g. no org_id condition)
  //    is a tenant-isolation failure.
  const missingTenantPredicate = await sql`
    SELECT DISTINCT n.nspname || '.' || c.relname AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','build','build_events')
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname IN ('org_id','organization_id')
          AND format_type(a.atttypid, NULL) = 'text'
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = n.nspname
          AND p.tablename = c.relname
          AND (
            COALESCE(p.qual, '') ILIKE '%org_id%'
            OR COALESCE(p.qual, '') ILIKE '%organization_id%'
            OR COALESCE(p.with_check, '') ILIKE '%org_id%'
            OR COALESCE(p.with_check, '') ILIKE '%organization_id%'
          )
      )
    ORDER BY tbl`;

  for (const { tbl } of missingTenantPredicate)
    check(`Tenant predicate in RLS policy on ${tbl}`, false, "RLS is enabled but no policy references org_id — the table is implicitly deny-all or mis-predicated");

  // 3. Tables that carry no tenant column at all but are tenant data by 0320's own rule:
  //    a NOT NULL single-column foreign key to an org-bearing parent. Checks 1 and 2 cannot
  //    see these — both require the org column to exist — so a table that lost its tenant
  //    column entirely passes precisely because it is more broken, not less. 0320 swept the
  //    catalogue rather than naming its tables, so which tables it covered depends on the
  //    shape of the database at the moment it ran: it reached 66 tables in the control plane
  //    and 69 in a cold cell.
  const missingTenantColumn = await sql`
    SELECT n.nspname || '.' || c.relname AS tbl,
           (SELECT parent.relname FROM pg_constraint con
              JOIN pg_class parent ON parent.oid = con.confrelid
              JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
             WHERE con.conrelid = c.oid AND con.contype = 'f'
               AND array_length(con.conkey, 1) = 1 AND ca.attnotnull
               AND EXISTS (SELECT 1 FROM pg_attribute pa WHERE pa.attrelid = con.confrelid
                            AND pa.attname IN ('org_id','organization_id') AND NOT pa.attisdropped)
             LIMIT 1) AS parent
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','build','build_events')
      AND c.relkind = 'r'
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname IN ('org_id','organization_id')
      )
    ORDER BY tbl`;

  for (const { tbl, parent } of missingTenantColumn) {
    if (parent === null) continue;
    if (classifyTable(tbl) !== "IN-SCOPE") {
      console.log(`SKIP  ${tbl} — ${classifyTable(tbl)}`);
      continue;
    }
    check(
      `tenant column on ${tbl}`,
      false,
      `child of org-bearing ${parent} via a NOT NULL foreign key but carries no org_id — ` +
        "no RLS policy can be written for it, and checks 1 and 2 cannot see it",
    );
  }

  const notForced = await sql`
    SELECT DISTINCT n.nspname || '.' || c.relname AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname IN ('public','build','build_events')
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
      AND a.attname IN ('org_id','organization_id')
      AND format_type(a.atttypid, NULL) = 'text'
    ORDER BY tbl`;

  const notForcedTenant = notForced.filter(({ tbl }) => classifyTable(tbl) === "IN-SCOPE");
  if (notForcedTenant.length > 0) {
    const SHOW_MAX = 20;
    const shown = notForcedTenant.slice(0, SHOW_MAX).map(({ tbl }) => tbl);
    const extra = notForcedTenant.length - shown.length;
    console.log(
      `\nADVISORY  ${notForcedTenant.length} table(s) have RLS enabled but FORCE ROW LEVEL SECURITY is not set.` +
      `\n          FORCE binds only the table owner, not the app role (streamline_app is a non-owner).` +
      `\n          neondb_owner has BYPASSRLS which overrides FORCE anyway, so this is benign` +
      `\n          under the current connection topology.` +
      `\n          Escalate to a hard failure if a table-owner connection enters the request path.`,
    );
    for (const tbl of shown) console.log(`  advisory  ${tbl}`);
    if (extra > 0) console.log(`  … and ${extra} more (not shown)`);
  }

  await sql.end();
}

console.log(failures === 0 ? "\nRESULT: RLS VERIFIED" : `\nRESULT: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
