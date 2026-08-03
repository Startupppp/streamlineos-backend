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
  const [coverage] = await sql`
    SELECT
      (SELECT count(DISTINCT c.oid)::int FROM pg_class c
        JOIN pg_namespace n2 ON n2.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n2.nspname='public' AND c.relkind='r'
          AND a.attname IN ('org_id','organization_id')
          AND format_type(a.atttypid, NULL)='text') AS tenant_columns,
      (SELECT count(*)::int FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relrowsecurity) AS rls_enabled`;
  console.log(
    `
coverage: ${coverage.rls_enabled} of ${coverage.tenant_columns} tenant-scoped tables have RLS enabled`,
  );
  await sql.end();
}

console.log(failures === 0 ? "\nRESULT: RLS VERIFIED" : `\nRESULT: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
