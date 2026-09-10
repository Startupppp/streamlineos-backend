import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PROBE_SPECS, UNCATALOGUED_MODULE } from "./verify-rbac-probes.mjs";
import { REQUIRED_CONSTRAINTS, describeError, verdict } from "./verify-rbac-verdict.mjs";
import { administeringModuleOf } from "./permission-key-extractors.mjs";

class Rollback extends Error {}

async function seedOrg(tx, tag, nonce) {
  const orgId = `probe-org-${tag}-${nonce}`;
  const userId = `probe-user-${tag}-${nonce}`;
  await tx`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@rbac-probe.invalid`})`;
  await tx`INSERT INTO organizations (id, name, slug, owner_membership_id)
           VALUES (${orgId}, ${`RBAC probe ${tag} ${nonce}`}, ${orgId}, 0)`;
  const [member] = await tx`
    INSERT INTO organization_members (user_id, org_id) VALUES (${userId}, ${orgId}) RETURNING id`;
  await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;
  return { orgId, memberId: member.id };
}

/**
 * Every probe builds its own tenants, memberships and role inside the transaction it rolls back.
 * Nothing pre-exists, so no probe can collide on a unique index and be scored on 23505 instead of
 * the foreign key it names — and no data has to be seeded for the gate to run at all.
 */
async function buildFixture(tx) {
  const nonce = randomUUID();
  const a = await seedOrg(tx, "a", nonce);
  const b = await seedOrg(tx, "b", nonce);
  const [role] = await tx`
    INSERT INTO roles (name, slug, org_id, rank)
    VALUES (${`RBAC probe ${nonce}`}, ${`rbac-probe-${nonce}`}, ${a.orgId}, 40) RETURNING id`;
  return { nonce, orgA: a.orgId, memberA: a.memberId, orgB: b.orgId, memberB: b.memberId, roleA: role.id };
}

async function probe(sql, spec, catalog) {
  const observed = { phase: "fixture", error: null };
  try {
    await sql.begin(async (tx) => {
      const fixture = await buildFixture(tx);
      observed.phase = "probe";
      await spec.run(tx, fixture, catalog);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) observed.error = error;
  }
  return { spec, ...verdict(spec, observed) };
}

async function resolveCatalog(sql) {
  const [uncatalogued] = await sql`
    SELECT 1 AS hit FROM modules_catalog WHERE module_key = ${UNCATALOGUED_MODULE}`;
  const [hostModule] = await sql`SELECT module_key FROM modules_catalog ORDER BY module_key LIMIT 1`;
  const [permission] = await sql`
    SELECT name, administering_module_key FROM permissions
    WHERE administering_module_key IS NOT NULL ORDER BY name LIMIT 1`;
  const [unadministered] = await sql`
    SELECT name FROM permissions WHERE administering_module_key IS NULL ORDER BY name LIMIT 1`;
  const [driftModule] = permission
    ? await sql`SELECT module_key FROM modules_catalog
                WHERE module_key <> ${permission.administering_module_key} ORDER BY module_key LIMIT 1`
    : [];

  const missing = [];
  if (uncatalogued)
    missing.push(`modules_catalog contains '${UNCATALOGUED_MODULE}', so the uncatalogued-module probes cannot bite.`);
  if (!hostModule) missing.push("modules_catalog is empty — no module key exists to grant anything under.");
  if (!permission)
    missing.push("no permission carries an administering_module_key — the composite grant FK cannot be probed.");
  if (!driftModule)
    missing.push("modules_catalog holds fewer than two modules — namespace drift cannot be constructed.");
  if (!unadministered)
    missing.push("no permission has a NULL administering_module_key — the not-grantable probe cannot be constructed.");
  if (missing.length > 0) return { missing };

  return {
    hostModule: hostModule.module_key,
    permission: permission.name,
    permissionModule: permission.administering_module_key,
    driftModule: driftModule.module_key,
    unadministered: unadministered.name,
    missing: [],
  };
}

async function checkConstraints(sql) {
  const present = await sql`
    SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY(${REQUIRED_CONSTRAINTS})`;
  const byName = new Map(present.map((row) => [row.conname, row.convalidated]));
  let failures = 0;
  for (const name of REQUIRED_CONSTRAINTS) {
    if (!byName.has(name)) {
      console.log(`  MISSING  ${name}`);
      failures += 1;
    } else if (byName.get(name) !== true) {
      console.log(`  NOT VALID  ${name}`);
      failures += 1;
    }
  }
  return failures;
}

async function checkStoredGrants(sql) {
  const rows = await sql`SELECT g.permission_key, g.module_key FROM user_permission_grants g`;
  let failures = 0;
  for (const row of rows) {
    if (administeringModuleOf(row.permission_key) !== row.module_key) {
      console.log(`  DRIFT  ${row.permission_key} stored under ${row.module_key}`);
      failures += 1;
    }
  }
  return failures;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  let failures = 0;
  try {
    failures += await checkConstraints(sql);
    failures += await checkStoredGrants(sql);

    const catalog = await resolveCatalog(sql);
    if (catalog.missing.length > 0) {
      for (const line of catalog.missing) console.error(`  MISSING PRECONDITION  ${line}`);
      console.error(
        "\nFAIL — the database cannot support the probes, so this gate asserts nothing here. It never " +
          "skips: a skip is indistinguishable from a pass. Bootstrap the database to journal head and re-run.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `  catalog: permission '${catalog.permission}' administered by '${catalog.permissionModule}', ` +
        `drift target '${catalog.driftModule}', unadministered '${catalog.unadministered}'`,
    );

    for (const spec of PROBE_SPECS) {
      const row = await probe(sql, spec, catalog);
      const claim = spec.expect === "ACCEPT" ? "ACCEPT" : `${spec.sqlstate}/${spec.constraint}`;
      console.log(`  ${row.pass ? "PASS" : "FAIL"}  [${claim}]  ${spec.label(catalog)} — ${row.why}`);
      if (!row.pass) failures += 1;
    }
  } catch (error) {
    console.error(`  UNREADABLE DATABASE  ${describeError(error)}`);
    console.error(
      "\nFAIL — the gate could not read the RBAC schema, so it asserted nothing. That is a failure, " +
        "not a skip. Point DATABASE_URL at a database bootstrapped to journal head.",
    );
    process.exitCode = 1;
    return;
  } finally {
    await sql.end();
  }

  console.log(
    failures === 0
      ? `\nOK — ${PROBE_SPECS.length} probes over ${REQUIRED_CONSTRAINTS.length} constraints: every rejection ` +
          "carried the exact SQLSTATE and constraint claimed, and every control was permitted."
      : `\nFAIL — ${failures} problem(s).`,
  );
  if (failures > 0) process.exitCode = 1;
}

if (process.argv.includes("--self-test")) {
  const { selfTest } = await import("./verify-rbac-self-test.mjs");
  selfTest();
} else await main();
