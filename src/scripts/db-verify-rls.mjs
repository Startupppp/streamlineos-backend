/**
 * db-verify-rls.mjs — scope-aware RLS coverage gate
 *
 * 1. Runtime behavioral probes: tenant isolation, cross-tenant write blocking,
 *    nullable-tenant path (0380 regression), tenant-id isolation after COMMIT.
 *
 * 2. Scope-aware catalog scan — every tenant table (org_id column) lands in
 *    exactly one named bucket:
 *
 *      IN-SCOPE COVERED    — RLS + org-predicate policy          → pass
 *      IN-SCOPE MISSING    — no RLS, or RLS with no org policy   → hard FAIL
 *      EXCLUDED: CRM       — crm_* prefix or CRM_TABLE_NAMES     → reported, not a fail
 *      EXCLUDED: INVENTORY — inv_* prefix or INV_TABLE_NAMES     → reported, not a fail
 *      PLATFORM-GLOBAL     — PLATFORM_GLOBAL_TABLES registry     → reported, not a fail
 *
 *    Unregistered tables default to IN-SCOPE — deny by default.
 *    CRM and Inventory are excluded from this release's scope (PRD §11).
 *
 * isCrmTable/isInvTable/CRM_TABLE_NAMES are copied from check-tenant-relationships.mjs
 * rather than imported because that script executes main() and a SELF_TEST block at the
 * module level. Extracting a shared module would require editing a file outside this
 * script's exclusive ownership during concurrent sessions. Keep both copies in sync.
 *
 * Usage: node --env-file-if-exists=.env src/scripts/db-verify-rls.mjs [--self-test]
 * Exit:  0 verified · 1 failures found
 */

import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const CRM_TABLE_NAMES = new Set([
  "clients", "leads", "deals", "contacts", "quotes", "pipelines", "pipeline_stages",
  "activities", "campaigns", "campaign_recipients", "quote_items", "contact_notes",
  "contact_tags", "deal_activities", "deal_approvals", "deal_meetings",
  "lead_activities", "lead_emails", "lead_notes", "lead_tasks",
  "enterprise_quotes", "client_accounts", "client_onboarding_items",
  "client_opportunities", "commissions", "csat_surveys", "quote_line_items",
  "vendor_credits", "credit_notes",
]);

const INV_TABLE_NAMES = new Set(["inv_items"]);

function isCrmTable(name) {
  return name.startsWith("crm_") || CRM_TABLE_NAMES.has(name);
}

function isInvTable(name) {
  return name.startsWith("inv_") || INV_TABLE_NAMES.has(name);
}

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

function classifyTable(qualifiedName) {
  if (PLATFORM_GLOBAL_TABLES.has(qualifiedName)) return "PLATFORM-GLOBAL";
  const bare = qualifiedName.includes(".") ? qualifiedName.split(".").pop() : qualifiedName;
  if (isCrmTable(bare)) return "EXCLUDED: CRM";
  if (isInvTable(bare)) return "EXCLUDED: INVENTORY";
  return "IN-SCOPE";
}

if (process.argv.includes("--self-test")) {
  const gateExcludes = (tbl) => classifyTable(tbl) !== "IN-SCOPE";

  const ST = {
    in_scope_no_rls_is_not_excluded: !gateExcludes("public.some_new_business_table"),
    in_scope_rls_no_policy_is_not_excluded: !gateExcludes("public.another_in_scope_table"),
    unrecognised_table_is_not_excluded: !gateExcludes("public.brand_new_undeclared_xyz"),
    inv_prefix_is_excluded: gateExcludes("public.inv_projects"),
    inv_project_requirements_is_excluded: gateExcludes("public.inv_project_requirements"),
    leads_is_excluded_as_crm: gateExcludes("public.leads"),
    deals_is_excluded_as_crm: gateExcludes("public.deals"),
    crm_prefix_is_excluded: classifyTable("public.crm_contacts") === "EXCLUDED: CRM",
    inv_named_is_excluded: classifyTable("public.inv_items") === "EXCLUDED: INVENTORY",
    platform_global_is_excluded: classifyTable("public.organization_placement") === "PLATFORM-GLOBAL",
    in_scope_schema_build: classifyTable("build.tickets") === "IN-SCOPE",
    hr_table_is_in_scope: classifyTable("public.hr_employees") === "IN-SCOPE",
  };

  const pass = Object.values(ST).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks: ST }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

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
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

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

  const tenantTables = await sql`
    SELECT DISTINCT n.nspname || '.' || c.relname AS tbl,
      c.relrowsecurity AS has_rls,
      EXISTS(
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = n.nspname AND p.tablename = c.relname
          AND (
            COALESCE(p.qual, '')        ILIKE '%org_id%'
            OR COALESCE(p.qual, '')        ILIKE '%organization_id%'
            OR COALESCE(p.with_check, '') ILIKE '%org_id%'
            OR COALESCE(p.with_check, '') ILIKE '%organization_id%'
          )
      ) AS has_org_policy
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname IN ('public','build','build_events')
      AND c.relkind = 'r'
      AND a.attname IN ('org_id','organization_id')
      AND format_type(a.atttypid, NULL) = 'text'
    ORDER BY tbl`;

  const buckets = {
    inScopeCovered: [],
    inScopeMissing: [],
    platformGlobal: [],
    excludedCrm: [],
    excludedInv: [],
  };

  for (const { tbl, has_rls, has_org_policy } of tenantTables) {
    const bucket = classifyTable(tbl);
    if (bucket === "PLATFORM-GLOBAL") {
      buckets.platformGlobal.push(tbl);
    } else if (bucket === "EXCLUDED: CRM") {
      buckets.excludedCrm.push(tbl);
    } else if (bucket === "EXCLUDED: INVENTORY") {
      buckets.excludedInv.push(tbl);
    } else if (has_rls && has_org_policy) {
      buckets.inScopeCovered.push(tbl);
    } else if (has_rls) {
      buckets.inScopeMissing.push(tbl);
      check(
        `Tenant predicate in RLS policy on ${tbl}`,
        false,
        "in-scope: RLS is enabled but no policy references org_id — implicitly deny-all or mis-predicated",
      );
    } else {
      buckets.inScopeMissing.push(tbl);
      check(
        `RLS enabled on ${tbl}`,
        false,
        "in-scope tenant table has no RLS — add a policy or register in PLATFORM_GLOBAL_TABLES",
      );
    }
  }

  const total = tenantTables.length;
  const SHOW_MAX = 20;

  console.log(`\nBUCKET SUMMARY  (${total} tenant-scoped tables scanned)`);
  console.log(`  IN-SCOPE COVERED:     ${String(buckets.inScopeCovered.length).padStart(4)}`);
  console.log(`  IN-SCOPE MISSING:     ${String(buckets.inScopeMissing.length).padStart(4)}${buckets.inScopeMissing.length > 0 ? "  ← hard FAIL" : ""}`);
  console.log(`  PLATFORM-GLOBAL:      ${String(buckets.platformGlobal.length).padStart(4)}`);
  console.log(`  EXCLUDED: CRM:        ${String(buckets.excludedCrm.length).padStart(4)}`);
  console.log(`  EXCLUDED: INVENTORY:  ${String(buckets.excludedInv.length).padStart(4)}`);

  if (buckets.excludedInv.length > 0) {
    console.log(`\nEXCLUDED: INVENTORY — CRM and Inventory are out of this release's scope (not a failure)`);
    for (const tbl of buckets.excludedInv) console.log(`  excluded  ${tbl}`);
  }

  if (buckets.excludedCrm.length > 0) {
    const shown = buckets.excludedCrm.slice(0, SHOW_MAX);
    const extra = buckets.excludedCrm.length - shown.length;
    console.log(`\nEXCLUDED: CRM — CRM and Inventory are out of this release's scope (not a failure)`);
    for (const tbl of shown) console.log(`  excluded  ${tbl}`);
    if (extra > 0) console.log(`  … and ${extra} more`);
  }

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
    const bucket = classifyTable(tbl);
    if (bucket === "PLATFORM-GLOBAL") {
      console.log(`SKIP  ${tbl} — registered as platform-global`);
      continue;
    }
    if (bucket === "EXCLUDED: CRM" || bucket === "EXCLUDED: INVENTORY") {
      console.log(`excluded  ${tbl} — ${bucket} (no tenant column, child of ${parent})`);
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

  const notForcedTenant = notForced.filter(({ tbl }) => {
    const bucket = classifyTable(tbl);
    return bucket !== "PLATFORM-GLOBAL" && bucket !== "EXCLUDED: CRM" && bucket !== "EXCLUDED: INVENTORY";
  });

  if (notForcedTenant.length > 0) {
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
