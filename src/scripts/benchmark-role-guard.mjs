/**
 * benchmark-role-guard.mjs — the one place that decides whether a benchmark run is
 * measuring under the application role with RLS in force.
 *
 * PRD-C079 says a plan taken as the database owner is worthless: the owner carries
 * BYPASSRLS, so every row-security qual is planned away and the plan omits exactly the
 * authorization predicates the criterion asks to see. Three harnesses used to answer
 * that question three different ways — one asserted it live, one silently fell back to
 * the owner's URL, one wrote the answer as a string literal. This module is the single
 * decision they now share, and every part of it is a pure function so a spec can prove
 * each refusal without a database.
 */

/**
 * The connection URL a benchmark may use. `DATABASE_URL` is the owner's URL in every
 * environment file in this repo, so accepting it as a fallback is the same defect as
 * measuring as the owner on purpose — it just fails silently instead of loudly.
 */
export function resolveAppDatabaseUrl(env) {
  const url = env.APP_DATABASE_URL;
  if (!url)
    return {
      ok: false,
      why:
        "APP_DATABASE_URL is required (the non-BYPASSRLS app role). " +
        "DATABASE_URL is NOT accepted as a fallback: it names the owner, which carries BYPASSRLS, " +
        "and every plan taken through it omits the RLS qual.",
    };
  return { ok: true, url };
}

/**
 * TLS follows PGSSLMODE the way every sibling harness does. A hardcoded `ssl: "require"`
 * cannot reach a local scratch target at all, which is how a harness ends up only ever
 * being pointed at the remote (owner-credentialled) database.
 */
export function resolveSsl(env) {
  return env.PGSSLMODE === "disable" ? false : "require";
}

/**
 * The table a no-GUC probe must be taken against. Not every RLS policy in this schema
 * behaves the same way under a missing tenant context: `organization_members` matches no
 * rows and answers 0, so probing it proves NOTHING — a BYPASSRLS owner and a fully
 * unprotected database both answer 0 as well. `calendar_events` is policed by
 * `current_org_id()`, which RAISES 42501, so it is the only shape that distinguishes
 * "RLS is in force" from "the read simply found nothing". Measured 2026-09-04 against
 * scratch_perf_seed and scratch_gates_head as streamline_app.
 *
 * A harness may probe a different relation when it is closer to what that harness
 * measures — capture-build-baseline.mjs probes `build.tickets`, verified 2026-09-04 to
 * raise 42501 on the same targets — but only ever one whose policy RAISES. Never
 * `organization_members`.
 */
export const RLS_PROBE_RELATION = "calendar_events";

/**
 * @param role  { name, rolbypassrls, rolsuper } as read live from pg_roles.
 * @param deniedWithoutGuc  true when a read with no tenant GUC raised 42501.
 * @returns a refusal string, or null when the posture is sound.
 */
export function roleRefusal(role, deniedWithoutGuc) {
  if (!role || typeof role.name !== "string")
    return "REFUSING TO MEASURE: could not read the connected role from pg_roles.";
  if (role.rolbypassrls || role.rolsuper)
    return (
      `REFUSING TO MEASURE: connected as "${role.name}" ` +
      `(bypassrls=${Boolean(role.rolbypassrls)} superuser=${Boolean(role.rolsuper)}). ` +
      "Every plan taken this way omits the RLS qual and is worthless."
    );
  if (deniedWithoutGuc !== true)
    return (
      "REFUSING TO MEASURE: a tenant-scoped read answered with no tenant GUC set. " +
      "RLS is not in force on this target, so nothing measured here would carry the tenant predicate."
    );
  return null;
}

/** The provenance line recorded in an artifact. Derived from the live read, never typed by hand. */
export function formatRoleProvenance(role) {
  return `${role.name} (rolbypassrls = ${Boolean(role.rolbypassrls)}, tenant GUC set)`;
}

const PROVEN_NON_BYPASSRLS = /rolbypassrls\s*=\s*false/i;

/**
 * Read the role provenance off a measurement artifact. A manifest may only claim the
 * role its input artifact actually observed; a script that writes the claim itself is
 * asserting, not measuring, and a hardcoded provenance claim is worse than an absent one
 * because it survives being pointed at the owner.
 */
export function resolveMeasurementRole(artifact) {
  const role = artifact?.role;
  if (typeof role !== "string" || role.length === 0)
    return {
      ok: false,
      why:
        "the measurement artifact carries no observed `role` — re-run run-read-cost-budgets.mjs, " +
        "which records the role it read from pg_roles. The manifest must not assert a role of its own.",
    };
  if (!PROVEN_NON_BYPASSRLS.test(role))
    return { ok: false, why: `the artifact role is not proven non-BYPASSRLS: ${JSON.stringify(role)}` };
  return { ok: true, role };
}
