#!/usr/bin/env node
/**
 * Preflight for migration 1094_hr_module_roles_drop_org_membership_admin.sql.
 *
 * Reports, without changing anything, how many rows that migration would remove:
 * `settings:organization:manage` grants held by the HR module rungs HR_MODULE_ADMIN and
 * HR_MODULE_OWNER, grouped by organisation and role, plus the HR-attributed per-person grants and
 * the delegated copies whose delegator is neither the owner nor an ORG_ADMIN. It also reports what
 * the migration deliberately KEEPS, so the blast radius is visible rather than asserted.
 *
 * Read-only: every statement is a SELECT.
 *
 * Safety: it takes its OWN variable (HR_ORG_ADMIN_REVOKE_DATABASE_URL) and never falls back to
 * DATABASE_URL, because `.env` alone points at production. A non-loopback host is refused unless
 * --allow-remote is passed explicitly.
 *
 * Two ways the report can lie, both checked before the numbers are printed:
 *   - RLS. `role_permission_grants` is tenant-scoped. A connection as the application role with no
 *     `app.current_org_id` GUC sees nothing and the report reads as "no grants anywhere". Connect as
 *     the role `db:migrate` uses; the script refuses to print a clean bill under a role that can
 *     neither bypass RLS nor is superuser while RLS is enabled.
 *   - Vacuity. A database where the key has no grants at all — an empty scratch DB that was never
 *     seeded — proves nothing about the migration. That exits 2, not 0.
 *
 * Usage:
 *   HR_ORG_ADMIN_REVOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/scratch_local \
 *     node src/scripts/preflight-hr-module-org-admin-revocation.mjs [--allow-remote]
 *   node src/scripts/preflight-hr-module-org-admin-revocation.mjs --self-test
 *
 * Exit:
 *   0  report produced and every removable row belongs to an HR module rung
 *   1  refused (missing/remote target), a query failed, or a row outside the HR module rungs
 *      appeared in the removal set
 *   2  vacuous — the key has no grants on this database, so the report measures nothing
 */
import postgres from "postgres";

const PERMISSION_KEY = "settings:organization:manage";
const TARGET_SLUGS = ["HR_MODULE_ADMIN", "HR_MODULE_OWNER"];

const SELF_TEST = process.argv.includes("--self-test");
const ALLOW_REMOTE = process.argv.includes("--allow-remote");

export function isLoopbackTarget(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function resolveTarget(env, allowRemote) {
  const url = env.HR_ORG_ADMIN_REVOKE_DATABASE_URL;
  if (!url)
    return {
      ok: false,
      reason:
        "HR_ORG_ADMIN_REVOKE_DATABASE_URL is required. This preflight deliberately does not fall back to DATABASE_URL.",
    };
  if (!isLoopbackTarget(url) && !allowRemote)
    return {
      ok: false,
      reason:
        "Refusing a non-loopback target without --allow-remote. Point this at a disposable database.",
    };
  return { ok: true, url };
}

/**
 * A role that can see neither past RLS nor around it reads every tenant table as empty, so a zero
 * here is indistinguishable from a clean database. Returns the reason it would be untrustworthy, or
 * null when the connection can see the rows.
 */
export function rlsBlindness({ rowSecurityEnabled, isSuperuser, bypassesRls }) {
  if (!rowSecurityEnabled) return null;
  if (isSuperuser || bypassesRls) return null;
  return "row-level security is enabled on role_permission_grants and this role neither bypasses it nor is superuser — every count below would read zero regardless of the data";
}

export function classify({ removableRows, keyGrantsAnywhere, offSlugRows }) {
  if (offSlugRows > 0)
    return {
      code: 1,
      label: "UNEXPECTED",
      detail: `${offSlugRows} removable row(s) belong to a role outside ${TARGET_SLUGS.join("/")} — the migration predicate and this probe disagree`,
    };
  if (keyGrantsAnywhere === 0)
    return {
      code: 2,
      label: "VACUOUS",
      detail: `no role holds ${PERMISSION_KEY} on this database — the report measures nothing`,
    };
  return {
    code: 0,
    label: "OK",
    detail: `${removableRows} role grant row(s) would be removed`,
  };
}

function table(rows, columns) {
  if (rows.length === 0) {
    console.log("      (none)");
    return;
  }
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  console.log(`      ${columns.map((c, i) => c.padEnd(widths[i])).join("  ")}`);
  for (const row of rows)
    console.log(
      `      ${columns.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join("  ")}`,
    );
}

async function main() {
  const target = resolveTarget(process.env, ALLOW_REMOTE);
  if (!target.ok) {
    console.error(`REFUSED: ${target.reason}`);
    process.exit(1);
  }

  const sql = postgres(target.url, { prepare: false, max: 1 });
  try {
    const [who] = await sql`
      SELECT current_user AS role,
             current_database() AS db,
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
             (SELECT relrowsecurity FROM pg_class WHERE oid = 'role_permission_grants'::regclass) AS rls`;
    console.log(`target:   ${who.db} as ${who.role}`);
    console.log(
      `rls:      role_permission_grants rowsecurity=${who.rls} · superuser=${who.is_superuser} · bypassrls=${who.bypasses_rls}`,
    );

    const blind = rlsBlindness({
      rowSecurityEnabled: who.rls === true,
      isSuperuser: who.is_superuser === true,
      bypassesRls: who.bypasses_rls === true,
    });
    if (blind !== null) {
      console.error(`REFUSED: ${blind}`);
      process.exit(1);
    }

    const removable = await sql`
      SELECT g.org_id, r.slug, count(*)::int AS grants
      FROM role_permission_grants g
      JOIN roles r ON r.id = g.role_id AND r.org_id = g.org_id
      WHERE g.permission_key = ${PERMISSION_KEY}
        AND r.slug = ANY(${TARGET_SLUGS})
      GROUP BY g.org_id, r.slug
      ORDER BY g.org_id, r.slug`;

    const retained = await sql`
      SELECT r.slug, count(*)::int AS grants, count(DISTINCT g.org_id)::int AS orgs
      FROM role_permission_grants g
      JOIN roles r ON r.id = g.role_id AND r.org_id = g.org_id
      WHERE g.permission_key = ${PERMISSION_KEY}
        AND NOT (r.slug = ANY(${TARGET_SLUGS}))
      GROUP BY r.slug
      ORDER BY r.slug`;

    const [personGrants] = await sql`
      SELECT count(*) FILTER (WHERE module_key = 'hr')::int AS removable,
             count(*) FILTER (WHERE module_key <> 'hr')::int AS retained
      FROM user_permission_grants
      WHERE permission_key = ${PERMISSION_KEY}`;

    const [delegated] = await sql`
      SELECT count(*) FILTER (WHERE m.is_owner = false AND m.role <> 'ORG_ADMIN')::int AS removable,
             count(*) FILTER (WHERE m.is_owner = true OR m.role = 'ORG_ADMIN')::int AS retained
      FROM user_delegation_permissions p
      JOIN user_delegations d ON d.id = p.delegation_id AND d.org_id = p.org_id
      JOIN organization_members m
        ON m.org_id = d.org_id AND m.id = d.delegator_membership_id
      WHERE p.permission_key = ${PERMISSION_KEY}`;

    const [anywhere] = await sql`
      SELECT count(*)::int AS grants
      FROM role_permission_grants
      WHERE permission_key = ${PERMISSION_KEY}`;

    const removableRows = removable.reduce((sum, row) => sum + row.grants, 0);
    const offSlugRows = removable.filter(
      (row) => !TARGET_SLUGS.includes(row.slug),
    ).length;

    console.log(`\n  role_permission_grants the migration REMOVES (by org and role):`);
    table(removable, ["org_id", "slug", "grants"]);
    console.log(
      `      total ${removableRows} row(s) across ${new Set(removable.map((r) => r.org_id)).size} organisation(s)`,
    );

    console.log(`\n  role_permission_grants the migration KEEPS (every other role):`);
    table(retained, ["slug", "grants", "orgs"]);

    console.log(`\n  user_permission_grants for ${PERMISSION_KEY}:`);
    console.log(
      `      removes ${personGrants.removable} (module_key='hr') · keeps ${personGrants.retained}`,
    );

    console.log(`\n  user_delegation_permissions for ${PERMISSION_KEY}:`);
    console.log(
      `      removes ${delegated.removable} (delegator is neither owner nor ORG_ADMIN) · keeps ${delegated.retained}`,
    );

    const verdict = classify({
      removableRows,
      keyGrantsAnywhere: anywhere.grants,
      offSlugRows,
    });
    console.log(`\n${verdict.label}: ${verdict.detail}`);
    process.exit(verdict.code);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

if (SELF_TEST) {
  const remote = { HR_ORG_ADMIN_REVOKE_DATABASE_URL: "postgres://u:p@db.example.com:5432/x" };
  const local = { HR_ORG_ADMIN_REVOKE_DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x" };
  const checks = [
    ["missing var is refused", resolveTarget({}, false).ok === false],
    ["DATABASE_URL is not a fallback", resolveTarget({ DATABASE_URL: local.HR_ORG_ADMIN_REVOKE_DATABASE_URL }, false).ok === false],
    ["remote target refused without the flag", resolveTarget(remote, false).ok === false],
    ["remote target allowed with the flag", resolveTarget(remote, true).ok === true],
    ["loopback target accepted", resolveTarget(local, false).ok === true],
    ["a bare word is not a loopback target", isLoopbackTarget("not-a-url") === false],
    [
      "an app role under RLS is reported blind",
      rlsBlindness({ rowSecurityEnabled: true, isSuperuser: false, bypassesRls: false }) !== null,
    ],
    [
      "a bypassrls role under RLS is trusted",
      rlsBlindness({ rowSecurityEnabled: true, isSuperuser: false, bypassesRls: true }) === null,
    ],
    [
      "no RLS on the table is trusted",
      rlsBlindness({ rowSecurityEnabled: false, isSuperuser: false, bypassesRls: false }) === null,
    ],
    [
      "an empty database is vacuous, not clean",
      classify({ removableRows: 0, keyGrantsAnywhere: 0, offSlugRows: 0 }).code === 2,
    ],
    [
      "a slug outside the HR rungs fails",
      classify({ removableRows: 3, keyGrantsAnywhere: 9, offSlugRows: 1 }).code === 1,
    ],
    [
      "a seeded database with HR rows passes",
      classify({ removableRows: 4, keyGrantsAnywhere: 12, offSlugRows: 0 }).code === 0,
    ],
    [
      "a seeded database where no HR rung holds it still passes",
      classify({ removableRows: 0, keyGrantsAnywhere: 12, offSlugRows: 0 }).code === 0,
    ],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) bad += 1;
  }
  process.exit(bad === 0 ? 0 : 1);
} else {
  main().catch((error) => {
    console.error(`preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
