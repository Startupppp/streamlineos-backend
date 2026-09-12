import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const KEY = "settings:organization:manage";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const UP = join(ROOT, "migrations", "1109_hr_module_roles_drop_org_membership_admin.sql");
const DOWN = join(ROOT, "migrations", "rollback", "1109_hr_module_roles_drop_org_membership_admin.down.sql");

const results = [];
let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

function statements(file) {
  return readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter((s) => s.length > 0);
}

function requireDisposableTarget(url, allowRemote) {
  if (!url) throw new Error("HR_ORG_ADMIN_REVOKE_DATABASE_URL is required; DATABASE_URL is not a fallback");
  const host = new URL(url).hostname;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !allowRemote) throw new Error(`refusing non-loopback target ${host} without --allow-remote`);
  return url;
}

async function main() {
  const url = requireDisposableTarget(
    process.env.HR_ORG_ADMIN_REVOKE_DATABASE_URL,
    process.argv.includes("--allow-remote"),
  );
  const sql = postgres(url, { max: 1, prepare: false });
  const [{ db }] = await sql`select current_database() as db`;
  console.log(`target:   ${db}`);

  const orgs = await sql`select id from organizations order by id limit 2`;
  if (orgs.length < 2) throw new Error("probe needs two organisations present");
  const [o1, o2] = [orgs[0].id, orgs[1].id];

  const retained = await sql`
    select name from permissions where name like 'hr:%' and name <> ${KEY} order by name limit 1`;
  if (retained.length === 0) throw new Error("probe needs one hr:* permission present");
  const RETAINED_KEY = retained[0].name;
  console.log(`orgs:     ${o1}, ${o2}`);
  console.log(`retained: ${RETAINED_KEY}\n`);

  await sql.begin(async (tx) => {
    const mkRole = async (org, slug) => {
      const [row] = await tx`
        insert into roles (name, slug, org_id, is_system, module_key)
        values (${slug}, ${slug}, ${org}, false, 'hr') returning id`;
      return row.id;
    };
    const grant = async (org, roleId, key) => {
      await tx`insert into role_permission_grants (org_id, role_id, permission_key, scope)
               values (${org}, ${roleId}, ${key}, 'all')`;
    };

    const hrAdmin1 = await mkRole(o1, "HR_MODULE_ADMIN");
    const hrOwner1 = await mkRole(o1, "HR_MODULE_OWNER");
    const hrAdmin2 = await mkRole(o2, "HR_MODULE_ADMIN");
    const orgAdmin1 = await mkRole(o1, "ORG_ADMIN");
    const branchHr1 = await mkRole(o1, "BRANCH_HR");

    await grant(o1, hrAdmin1, KEY);
    await grant(o1, hrOwner1, KEY);
    await grant(o2, hrAdmin2, KEY);
    await grant(o1, orgAdmin1, KEY);
    await grant(o1, branchHr1, KEY);
    await grant(o1, hrAdmin1, RETAINED_KEY);

    const fixtureIds = [hrAdmin1, hrOwner1, hrAdmin2, orgAdmin1, branchHr1];
    const held = async (key) => {
      const rows = await tx`select role_id from role_permission_grants
        where permission_key = ${key} and role_id in ${tx(fixtureIds)} order by role_id`;
      return rows.map((r) => r.role_id);
    };
    const version = async (org) => {
      const rows = await tx`select permissions_version from access_versions where org_id = ${org}`;
      return rows.length === 0 ? null : Number(rows[0].permissions_version);
    };

    check("fixture: five roles hold the key", (await held(KEY)).length, 5);
    const v1Before = await version(o1);
    const v2Before = await version(o2);

    // The FK pins (permission_key, module_key) to (permissions.name, administering_module_key).
    let hrAttributedWritable = true;
    try {
      await tx.savepoint(async (sp) => {
        await sp`insert into user_permission_grants (org_id, organization_membership_id, permission_key, scope, module_key)
                 values (${o1}, 1, ${KEY}, 'all', 'hr')`;
      });
    } catch {
      hrAttributedWritable = false;
    }
    check("an hr-attributed user_permission_grant is unwritable today (statement 2 is defensive)", hrAttributedWritable, false);

    for (const s of statements(UP)) await tx.unsafe(s);

    check("HR_MODULE_ADMIN and HR_MODULE_OWNER lost the key in both orgs", await held(KEY), [orgAdmin1, branchHr1].sort((a, b) => a - b));
    check("ORG_ADMIN retains the key", (await held(KEY)).includes(orgAdmin1), true);
    check("BRANCH_HR retains the key (a deliberate grant, not this defect)", (await held(KEY)).includes(branchHr1), true);
    check("the module rung keeps its other hr key", await held(RETAINED_KEY), [hrAdmin1]);
    check("org 1 permissions_version bumped", (await version(o1)) > (v1Before ?? 0), true);
    check("org 2 permissions_version bumped", (await version(o2)) > (v2Before ?? 0), true);

    const v1After = await version(o1);
    const v2After = await version(o2);
    for (const s of statements(UP)) await tx.unsafe(s);
    check("re-apply removes nothing", await held(KEY), [orgAdmin1, branchHr1].sort((a, b) => a - b));
    check("re-apply bumps no version (org 1)", await version(o1), v1After);
    check("re-apply bumps no version (org 2)", await version(o2), v2After);

    for (const s of statements(DOWN)) await tx.unsafe(s);
    check("rollback restores both module rungs", await held(KEY), fixtureIds.slice().sort((a, b) => a - b));
    check("rollback bumps the version again (org 1)", (await version(o1)) > v1After, true);

    throw new Error("__ROLLBACK__");
  }).catch((e) => {
    if (e.message !== "__ROLLBACK__") throw e;
  });

  const [{ n }] = await sql`select count(*)::int n from roles where slug in ('HR_MODULE_ADMIN','HR_MODULE_OWNER','ORG_ADMIN','BRANCH_HR')`;
  check("transaction rolled back: no fixture role survives", n, 0);

  await sql.end();
  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`ERR ${e.message}`);
  process.exit(1);
});
