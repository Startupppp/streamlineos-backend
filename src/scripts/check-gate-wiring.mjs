#!/usr/bin/env node
/**
 * Every `check:*` script in package.json must be referenced by a workflow, or be listed here
 * with a reason.
 *
 * Written 2026-09-03 after measuring that TEN gates across the two repositories existed in
 * package.json and were referenced by no workflow at all — among them
 * `check:permission-binding`, which had found 27 real permission/route mismatches on the day it
 * was written, and `check:tenant-isolation:run`, which is the gate that actually EXECUTES the
 * cross-tenant isolation suites.
 *
 * A gate that cannot run is indistinguishable from a gate that passes. That is the defect class
 * this release keeps finding — a budget whose SQL read a different table, a purge that verified
 * the wrong bucket, a ratchet whose workflow pointed at a directory that does not exist. This
 * closes the version of it that applies to gates themselves.
 *
 * An exception must carry a real reason. "Needs a live database" is one; "not yet" is not.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO = ROOT;
const WORKFLOWS = join(REPO, ".github", "workflows");

/** Sub-commands that assert nothing on their own — they emit, list or self-test. */
const HELPER = /:(self-test|fix|emit|list|baseline|write|report|verify|build)$/;

/** gate -> the reason it is deliberately not in a workflow. Must be specific. */
const UNWIRED_BY_DESIGN = Object.freeze({
  "check:declaration-column-drift":
    "reads pg_attribute on a live database at journal head; the hermetic `gates` job has none. " +
    "Runs in db-gates.yml when a bootstrapped target exists. Owner: gate-wiring.",
  "check:declaration-constraint-drift":
    "same — compares getTableConfig against pg_constraint/pg_index on a live database. " +
    "Owner: gate-wiring.",

  // Widened 2026-09-03 to `verify:*` and `db:check-*`. All eight below query a live database at
  // journal head, which the hermetic `gates` job has none of. Recorded rather than left silent:
  // before this, nothing said they do not run.
  "verify:permissions": "queries a live database to resolve permissions. Owner: gate-wiring.",
  "verify:chat-mentions": "queries live chat rows. Owner: gate-wiring.",
  "verify:multi-org-employment": "queries live employment rows across orgs. Owner: gate-wiring.",
  "verify:membership-revocation": "queries live membership rows. Owner: gate-wiring.",
  "db:check-build-reads": "EXPLAINs against a live database as streamline_app. Owner: gate-wiring.",
  "db:check-hr-reads": "EXPLAINs against a live database as streamline_app. Owner: gate-wiring.",
  "db:check-read-budgets": "EXPLAINs against a live database as streamline_app. Owner: gate-wiring.",
  "db:check-request-txn": "needs a booted app plus a live database. Owner: gate-wiring.",
});

const MIN_GATES = 60; // anti-vacuity: a run that resolves nothing must fail, not pass.

function main() {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};
  // `check:*` is not the whole gate surface: `verify:*` and `db:check-*` assert too, and eight of
  // them were unwired when this was widened. `db:push`/`db:studio`/`db:migrate` are tools, not
  // gates, so the prefix test is deliberately narrow.
  const isGate = (n) =>
    !HELPER.test(n) && (n.startsWith("check:") || n.startsWith("verify:") || n.startsWith("db:check-"));
  const gates = Object.keys(scripts).filter(isGate);

  let workflows = "";
  for (const f of readdirSync(WORKFLOWS)) {
    if (f.endsWith(".yml") || f.endsWith(".yaml")) workflows += readFileSync(join(WORKFLOWS, f), "utf8");
  }

  if (gates.length < MIN_GATES) {
    console.error(`check-gate-wiring: resolved only ${gates.length} gates (floor ${MIN_GATES}) — the scan is broken, not the repo.`);
    process.exit(1);
  }
  if (workflows.length === 0) {
    console.error("check-gate-wiring: read no workflow content — the scan is broken, not the repo.");
    process.exit(1);
  }

  const unwired = gates.filter((g) => !workflows.includes(g) && !(g in UNWIRED_BY_DESIGN));
  const staleExceptions = Object.keys(UNWIRED_BY_DESIGN).filter(
    (g) => !gates.includes(g) || workflows.includes(g),
  );

  for (const g of staleExceptions)
    console.error(`  STALE EXCEPTION: ${g} — it is wired now, or no longer exists. Remove the entry.`);
  for (const g of unwired)
    console.error(`  UNWIRED: ${g} — referenced by no workflow, so it can never run.`);

  if (unwired.length || staleExceptions.length) {
    console.error(
      `\ncheck-gate-wiring: ${unwired.length} unwired, ${staleExceptions.length} stale.\n` +
        `Wire it into .github/workflows/, or add it to UNWIRED_BY_DESIGN with the reason.`,
    );
    process.exit(1);
  }
  console.log(
    `check-gate-wiring: ${gates.length} gates, all wired ` +
      `(${Object.keys(UNWIRED_BY_DESIGN).length} deliberate exceptions).`,
  );
}

main();
