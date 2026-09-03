import { PROBE_SPECS } from "./verify-rbac-probes.mjs";
import { REQUIRED_CONSTRAINTS, administeringModuleOf, sqlErrorShape, verdict } from "./verify-rbac-verdict.mjs";

const FK = { expect: "REJECT", sqlstate: "23503", constraint: "fk_role_assignments_assigner_membership" };
const ACCEPT = { expect: "ACCEPT" };

/** The bare shape postgres-js raises. */
function pgError(code, constraintName) {
  return Object.assign(new Error(`probe ${code}`), { code, constraint_name: constraintName, table_name: "t" });
}

/** The shape drizzle-orm 0.45.2 raises: no `.code` of its own, the driver error on `.cause`. */
function drizzleWrapped(code, constraintName) {
  return Object.assign(new Error("Failed query: insert into ..."), { cause: pgError(code, constraintName) });
}

function rejectedWith(error) {
  return { phase: "probe", error };
}

const rejectConstraints = new Set(
  PROBE_SPECS.filter((s) => s.expect === "REJECT").map((s) => s.constraint),
);

export function selfTest() {
  const checks = {
    chatFoldsIntoHome: administeringModuleOf("chat:messages:read") === "home",
    mailFoldsIntoHome: administeringModuleOf("mail:threads:read") === "home",
    partyFoldsIntoCrm: administeringModuleOf("party:accounts:view") === "crm",
    hrIsItsOwnModule: administeringModuleOf("hr:employees:view") === "hr",
    platformNamespaceUnchanged: administeringModuleOf("settings:manage") === "settings",

    readsBarePostgresError: sqlErrorShape(pgError("23503", "fk_x")).constraint === "fk_x",
    readsThroughDrizzleCause: sqlErrorShape(drizzleWrapped("23503", "fk_x")).code === "23503",
    readsDrizzleCauseConstraint: sqlErrorShape(drizzleWrapped("23503", "fk_x")).constraint === "fk_x",
    readsNodePostgresSpelling:
      sqlErrorShape(Object.assign(new Error("x"), { code: "23503", constraint: "fk_x" })).constraint === "fk_x",
    plainErrorHasNoCode: sqlErrorShape(new Error("boom")).code === null,

    exactRejectPasses: verdict(FK, rejectedWith(pgError("23503", FK.constraint))).pass === true,
    exactRejectThroughDrizzlePasses:
      verdict(FK, rejectedWith(drizzleWrapped("23503", FK.constraint))).pass === true,

    // The defect this gate was recorded for: a unique violation used to score a REJECT pass.
    uniqueViolationFailsAReject: verdict(FK, rejectedWith(pgError("23505", "uniq_x"))).pass === false,
    notNullViolationFailsAReject: verdict(FK, rejectedWith(pgError("23502", null))).pass === false,
    checkViolationFailsAReject: verdict(FK, rejectedWith(pgError("23514", "chk_x"))).pass === false,
    missingTableFailsAReject: verdict(FK, rejectedWith(pgError("42P01", null))).pass === false,
    syntaxErrorFailsAReject: verdict(FK, rejectedWith(pgError("42601", null))).pass === false,
    permissionDeniedFailsAReject: verdict(FK, rejectedWith(pgError("42501", null))).pass === false,
    wrongConstraintSameCodeFailsAReject:
      verdict(FK, rejectedWith(pgError("23503", "fk_some_other_constraint"))).pass === false,
    unnamedConstraintFailsAReject: verdict(FK, rejectedWith(pgError("23503", null))).pass === false,
    nonPostgresErrorFailsAReject: verdict(FK, rejectedWith(new Error("socket closed"))).pass === false,
    permittedWriteFailsAReject: verdict(FK, { phase: "probe", error: null }).pass === false,

    acceptPassesOnlyWhenPermitted: verdict(ACCEPT, { phase: "probe", error: null }).pass === true,
    uniqueViolationFailsAnAccept: verdict(ACCEPT, rejectedWith(pgError("23505", "uniq_x"))).pass === false,
    foreignKeyFailsAnAccept: verdict(ACCEPT, rejectedWith(pgError("23503", "fk_x"))).pass === false,

    // A fixture that never built cannot be scored as either verdict.
    fixtureFailureFailsAReject: verdict(FK, { phase: "fixture", error: pgError("23505", "uniq_x") }).pass === false,
    fixtureFailureFailsAnAccept:
      verdict(ACCEPT, { phase: "fixture", error: pgError("23505", "uniq_x") }).pass === false,

    // Anti-vacuity: a constraint listed as required but never probed proves nothing.
    everyConstraintNamed: REQUIRED_CONSTRAINTS.length === 9,
    everyRequiredConstraintIsProbed: REQUIRED_CONSTRAINTS.every((c) => rejectConstraints.has(c)),
    everyProbedConstraintIsRequired: [...rejectConstraints].every((c) => REQUIRED_CONSTRAINTS.includes(c)),
    everyRejectNamesCodeAndConstraint: PROBE_SPECS.filter((s) => s.expect === "REJECT").every(
      (s) => typeof s.sqlstate === "string" && typeof s.constraint === "string",
    ),
    everyProbeLabelsItself: PROBE_SPECS.every(
      (s) => typeof s.label === "function" && typeof s.run === "function",
    ),
    rejectAndControlBothPresent:
      PROBE_SPECS.filter((s) => s.expect === "REJECT").length >= 9 &&
      PROBE_SPECS.filter((s) => s.expect === "ACCEPT").length >= 8,
  };

  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(JSON.stringify({ selfTest: true, pass: failed.length === 0, checks }, null, 2));
  if (failed.length > 0) {
    console.error(`SELF-TEST FAILED — ${failed.map(([name]) => name).join(", ")}`);
    process.exit(1);
  }
  console.log(
    `SELF-TEST OK — ${Object.keys(checks).length} checks: the verdict rejects a unique violation, a ` +
      `not-null violation, a check violation, a missing table, a syntax error, a permission denial, a ` +
      `wrong constraint and a non-Postgres error, and every one of the ${REQUIRED_CONSTRAINTS.length} ` +
      `required constraints is bitten by a probe.`,
  );
}
