import postgres from "postgres";

const NAMESPACE_TO_MODULE = new Map([
  ["home", "home"],
  ["chat", "home"],
  ["mail", "home"],
  ["calendar", "home"],
  ["notifications", "home"],
  ["crm", "crm"],
  ["party", "crm"],
]);

export function administeringModuleOf(permissionKey) {
  const namespace = permissionKey.split(":")[0] ?? "";
  return NAMESPACE_TO_MODULE.get(namespace) ?? namespace;
}

export const REQUIRED_CONSTRAINTS = [
  "fk_permissions_administering_module",
  "fk_role_assignments_assigner_membership",
  "fk_user_permission_grants_granter_membership",
  "fk_roles_module",
  "fk_module_ownerships_module",
  "fk_ownership_transfers_module",
  "fk_user_module_access_module",
  "fk_user_permission_grants_module",
  "fk_user_permission_grants_permission_module",
];

/**
 * A REJECT verdict means POSTGRES refused the write. It does not mean "something
 * threw".
 *
 * This used to score any error as a rejection, so when the fixture could not be
 * built and `role.id` threw a TypeError — no SQLSTATE, `error.code` undefined —
 * the cross-tenant probe "passed" without a statement ever reaching the server.
 * A negative probe that cannot tell a constraint from a crash is not a probe.
 * `BROKEN` is neither ACCEPT nor REJECT and never equals an expectation, so it
 * always fails and says why.
 */
export function classify(expected, rejectedCode) {
  if (rejectedCode === null) return { got: "ACCEPT", pass: expected === "ACCEPT" };
  if (rejectedCode === HARNESS_ERROR) return { got: "BROKEN", pass: false };
  return { got: "REJECT", pass: expected === "REJECT" };
}

export const HARNESS_ERROR = "HARNESS_ERROR";

function selfTest() {
  const checks = {
    chatFoldsIntoHome: administeringModuleOf("chat:messages:read") === "home",
    mailFoldsIntoHome: administeringModuleOf("mail:threads:read") === "home",
    partyFoldsIntoCrm: administeringModuleOf("party:accounts:view") === "crm",
    hrIsItsOwnModule: administeringModuleOf("hr:employees:view") === "hr",
    platformNamespaceUnchanged: administeringModuleOf("settings:manage") === "settings",
    rejectCountedAsReject: classify("REJECT", "23503").pass === true,
    acceptCountedAsAccept: classify("ACCEPT", null).pass === true,
    acceptWhenRejectExpectedFails: classify("REJECT", null).pass === false,
    rejectWhenAcceptExpectedFails: classify("ACCEPT", "23503").pass === false,
    // the vacuity this file shipped with: a harness crash must never read as a
    // database rejection, whichever verdict was expected
    harnessErrorNeverPassesAsReject: classify("REJECT", HARNESS_ERROR).pass === false,
    harnessErrorNeverPassesAsAccept: classify("ACCEPT", HARNESS_ERROR).pass === false,
    harnessErrorIsItsOwnVerdict: classify("REJECT", HARNESS_ERROR).got === "BROKEN",
    everyConstraintNamed: REQUIRED_CONSTRAINTS.length === 9,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(JSON.stringify({ selfTest: true, pass: failed.length === 0, checks }, null, 2));
  if (failed.length > 0) process.exit(1);
  console.log("SELF-TEST OK — namespace folding and verdict classification behave as claimed.");
}

async function probe(sql, label, expected, run) {
  let rejectedCode = null;
  try {
    await sql.begin(async (tx) => {
      await run(tx);
      throw new Error("__ROLLBACK__");
    });
  } catch (error) {
    // A Postgres rejection carries a five-character SQLSTATE. Anything without
    // one came from this script, not from the database.
    if (error.message !== "__ROLLBACK__") {
      rejectedCode = /^[0-9A-Z]{5}$/.test(String(error.code ?? "")) ? error.code : HARNESS_ERROR;
      if (rejectedCode === HARNESS_ERROR) {
        console.log(`  BROKEN PROBE  ${label} — ${error.message}`);
      }
    }
  }
  const { got, pass } = classify(expected, rejectedCode);
  return { label, expected, got, pass, code: rejectedCode };
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
    const present = await sql`
      SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY(${REQUIRED_CONSTRAINTS})`;
    const byName = new Map(present.map((row) => [row.conname, row.convalidated]));
    for (const name of REQUIRED_CONSTRAINTS) {
      if (!byName.has(name)) {
        console.log(`  MISSING  ${name}`);
        failures += 1;
      } else if (byName.get(name) !== true) {
        console.log(`  NOT VALID  ${name}`);
        failures += 1;
      }
    }

    const drifted = await sql`
      SELECT g.permission_key, g.module_key FROM user_permission_grants g`;
    for (const row of drifted) {
      if (administeringModuleOf(row.permission_key) !== row.module_key) {
        console.log(`  DRIFT  ${row.permission_key} stored under ${row.module_key}`);
        failures += 1;
      }
    }

    const orgs = await sql`
      SELECT DISTINCT ON (org_id) org_id, id FROM organization_members ORDER BY org_id, id LIMIT 2`;
    if (orgs.length < 2) {
      console.log("SKIP — fewer than two organizations with memberships; negative probes need two tenants.");
    } else {
      /**
       * `a` must be an org that HAS a role, not merely the first org by id.
       *
       * The old selection took the two lowest org_ids and asked for a role in
       * the first. On the shared branch that org has none — only 15 of 33 orgs
       * with memberships have any roles at all — so `role` came back undefined
       * and every role_assignments probe died on `role.id`. The two ACCEPT
       * controls failed loudly, which is the only reason this was visible; the
       * REJECT probe scored the TypeError as a rejection and passed.
       *
       * So pick `a` from orgs that can actually satisfy the fixture, and `b`
       * from any OTHER org — b is only ever used as a foreign membership id.
       */
      const [a] = await sql`
        SELECT DISTINCT ON (m.org_id) m.org_id, m.id
        FROM organization_members m
        WHERE EXISTS (SELECT 1 FROM roles r WHERE r.org_id = m.org_id)
        ORDER BY m.org_id, m.id
        LIMIT 1`;
      const b = orgs.find((o) => a && o.org_id !== a.org_id)
        ?? (await sql`
          SELECT DISTINCT ON (org_id) org_id, id FROM organization_members
          WHERE org_id <> ${a?.org_id ?? null} ORDER BY org_id, id LIMIT 1`)[0];
      if (!a || !b) {
        console.log("SKIP — need one organization holding a role plus a second organization; this database has no such pair.");
        console.log(`FAIL — ${failures} problem(s).`);
        process.exit(failures > 0 ? 1 : 2);
      }
      const [role] = await sql`SELECT id FROM roles WHERE org_id = ${a.org_id} LIMIT 1`;
      const results = [
        await probe(sql, "cross-tenant assigner on role_assignments", "REJECT", (tx) =>
          tx`INSERT INTO role_assignments (org_id, organization_membership_id, role_id, assigned_by_membership_id)
             VALUES (${a.org_id}, ${a.id}, ${role.id}, ${b.id})`),
        await probe(sql, "same-tenant assigner [control]", "ACCEPT", (tx) =>
          tx`INSERT INTO role_assignments (org_id, organization_membership_id, role_id, assigned_by_membership_id)
             VALUES (${a.org_id}, ${a.id}, ${role.id}, ${a.id})`),
        await probe(sql, "null assigner [control]", "ACCEPT", (tx) =>
          tx`INSERT INTO role_assignments (org_id, organization_membership_id, role_id, assigned_by_membership_id)
             VALUES (${a.org_id}, ${a.id}, ${role.id}, NULL)`),
        await probe(sql, "uncatalogued module on module_ownerships", "REJECT", (tx) =>
          tx`INSERT INTO module_ownerships (org_id, module_key, owner_membership_id)
             VALUES (${a.org_id}, 'not_a_real_module', ${a.id})`),
        await probe(sql, "uncatalogued module on roles", "REJECT", (tx) =>
          tx`INSERT INTO roles (name, slug, org_id, module_key, rank)
             VALUES ('Probe', 'PROBE_ROLE', ${a.org_id}, 'not_a_real_module', 40)`),
        await probe(sql, "namespace drift: chat key under crm", "REJECT", (tx) =>
          tx`INSERT INTO user_permission_grants (org_id, organization_membership_id, permission_key, module_key)
             VALUES (${a.org_id}, ${a.id}, 'chat:messages:read', 'crm')`),
        await probe(sql, "correct: chat key under home [control]", "ACCEPT", (tx) =>
          tx`INSERT INTO user_permission_grants (org_id, organization_membership_id, permission_key, module_key)
             VALUES (${a.org_id}, ${a.id}, 'chat:messages:read', 'home')`),
        await probe(sql, "correct: hr key under hr [control]", "ACCEPT", (tx) =>
          tx`INSERT INTO user_permission_grants (org_id, organization_membership_id, permission_key, module_key)
             VALUES (${a.org_id}, ${a.id}, 'hr:employees:view', 'hr')`),
        await probe(sql, "platform namespace settings:manage is not grantable", "REJECT", (tx) =>
          tx`INSERT INTO user_permission_grants (org_id, organization_membership_id, permission_key, module_key)
             VALUES (${a.org_id}, ${a.id}, 'settings:manage', 'settings')`),
        await probe(sql, "cross-tenant granter on user_permission_grants", "REJECT", (tx) =>
          tx`INSERT INTO user_permission_grants (org_id, organization_membership_id, permission_key, module_key, granted_by_membership_id)
             VALUES (${a.org_id}, ${a.id}, 'hr:employees:view', 'hr', ${b.id})`),
      ];
      for (const row of results) {
        console.log(`  ${row.pass ? "PASS" : "FAIL"}  expect=${row.expected} got=${row.got}  ${row.label}${row.code ? ` [${row.code}]` : ""}`);
        if (!row.pass) failures += 1;
      }
    }
  } finally {
    await sql.end();
  }

  console.log(
    failures === 0
      ? "\nOK — RBAC actor and module keys are referentially constrained, and the controls prove the constraints are not over-strict."
      : `\nFAIL — ${failures} problem(s).`,
  );
  if (failures > 0) process.exitCode = 1;
}

if (process.argv.includes("--self-test")) selfTest();
else await main();
