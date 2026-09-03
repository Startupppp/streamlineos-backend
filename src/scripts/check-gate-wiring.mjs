#!/usr/bin/env node
/**
 * Every `check:*` script in package.json must be invoked by a real `run:` step of a real job in
 * `.github/workflows/`, or be listed here with a reason.
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
 *
 * ---------------------------------------------------------------------------------------------
 * 2026-09-03 — THE MATCHER NO LONGER SEARCHES TEXT. It parses.
 *
 * This gate used to decide "wired" by asking whether the concatenated raw YAML *contained* the
 * gate's name. That has now failed in three distinct ways in this repository alone:
 *
 *   1. A gate named only in a `#` COMMENT counted as wired. `check:query-projections`, ticket
 *      20's own projection ratchet, was in package.json, in no run step and in no exception
 *      list, and this gate reported "96 gates, all wired" — because a comment at ci.yml:686
 *      describing a DIFFERENT gate happened to name it. Patched by stripping comments; that
 *      patch is now unnecessary, because a comment is not a node in a parsed document.
 *
 *   2. A workflow file that DID NOT PARSE AT ALL still reported every gate in it as wired.
 *      `ci.yml` carried the step `- name: A with: block does not ship a whole related row` — a
 *      plain YAML scalar may not contain ": " — so the entire file was invalid, GitHub loaded
 *      NOTHING from it, and all 96 gates in it were dead while this gate said they were fine.
 *      Patched by a line rule; that rule is now a *hint* attached to a real parse failure
 *      rather than the check itself, because a hand-rolled rule can only ever cover the
 *      malformations someone already thought of.
 *
 *   3. A gate whose only mention was its own `:self-test` counted as wired. A self-test asserts
 *      the DETECTOR against planted defects; it does not read the repository. Running only the
 *      self-test proves the gate can bite and never asks it to.
 *
 * All three are the same shape: the evidence was text near the thing, not the thing. So the
 * matcher now walks `jobs.<id>.steps[].run` of a parsed document and compares whole shell
 * tokens. A comment, a commented-out step, a step under a `if: false`, a `name:` that merely
 * mentions the gate, and an unparseable file all fail — the last of them loudly, by file and
 * parse error, because that is how an entire CI file went dead unnoticed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

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

  // 2026-09-03 — BOTH OF THESE WERE HIDDEN BY THE SUBSTRING MATCHER. ci.yml runs their
  // `:self-test` and nothing else, and a gate name is a prefix of its own self-test, so the
  // old text search counted them wired. A self-test asserts the DETECTOR against planted
  // defects; it never reads the repository or the database. Both reasons below were measured,
  // not assumed.
  "check:alert-ack":
    "the live half exits 2 without ALERT_WEBHOOK_URL AND a nonce a human typed back from the " +
    "alert channel — proof a person received the page, which no CI job can fabricate " +
    "(check-alert-ack.mjs:178-188). ci.yml names the self-test only, and says so. " +
    "Owner: gate-wiring.",
});

/**
 * Anti-vacuity floors. A matcher that suddenly resolves nothing must FAIL, not congratulate
 * itself on zero unwired gates. Measured at head: 98 gates, 14 jobs, 148 run steps across the
 * 7 workflow files. The floors sit roughly 25% below each, so a legitimate deletion does not
 * trip them but a matcher that stops resolving does.
 */
const MIN_GATES = 90;
const MIN_JOBS = 10;
const MIN_RUN_STEPS = 110;

/**
 * Step names whose plain scalar contains ": ". Kept only to EXPLAIN a parse failure — the
 * parser is the authority on whether a file loads, and this rule can only recognise the one
 * malformation that has already bitten us.
 */
export function unquotedColonInName(file, text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const m = /^\s*(?:-\s+)?name:\s+(.*)$/.exec(line);
    if (!m) return;
    const value = m[1].replace(/\s+#.*$/, "").trim();
    if (!value || value.startsWith('"') || value.startsWith("'") || value.startsWith("|") || value.startsWith(">"))
      return;
    if (/:\s/.test(value)) out.push({ file, line: i + 1, text: line.trim() });
  });
  return out;
}

/** Whole shell tokens of a `run:` block — `a && b`, `a | b`, `a; b`, newlines, all split. */
export function shellTokens(run) {
  return run
    .split(/[\s;|&()]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Walk parsed workflows and return every executable `run:` step, plus every reason a file
 * could not be walked. A file that does not parse yields an error, never an empty success.
 */
export function collectRunSteps(files) {
  const runs = [];
  const errors = [];
  const jobIds = [];

  for (const { file, text } of files) {
    const doc = parseDocument(text, { prettyErrors: true });
    if (doc.errors.length > 0) {
      const first = doc.errors[0];
      const at = first.linePos?.[0] ? `${first.linePos[0].line}:${first.linePos[0].col}` : "?";
      errors.push({
        file,
        message: `${at} — ${first.message.split("\n")[0]}`,
        hints: unquotedColonInName(file, text),
      });
      continue;
    }

    let wf;
    try {
      wf = doc.toJS();
    } catch (err) {
      errors.push({ file, message: err instanceof Error ? err.message : String(err), hints: [] });
      continue;
    }

    if (wf === null || typeof wf !== "object" || Array.isArray(wf)) {
      errors.push({ file, message: "parses, but not as a mapping — it defines no workflow.", hints: [] });
      continue;
    }
    if (wf.jobs === null || typeof wf.jobs !== "object" || Array.isArray(wf.jobs)) {
      errors.push({ file, message: "parses, but has no `jobs:` mapping — nothing in it can run.", hints: [] });
      continue;
    }

    for (const [jobId, job] of Object.entries(wf.jobs)) {
      jobIds.push(`${file}:${jobId}`);
      if (job === null || typeof job !== "object" || Array.isArray(job)) continue;
      // A `uses:` job calls a reusable workflow and has no steps of its own; that is not an error.
      if (!Array.isArray(job.steps)) continue;
      for (const step of job.steps) {
        if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
        if (typeof step.run !== "string") continue;
        // `if: false` is a step pinned off. It is in the file and it never executes.
        if (step.if === false) continue;
        runs.push({ file, job: jobId, name: typeof step.name === "string" ? step.name : "(unnamed)", run: step.run });
      }
    }
  }

  return { runs, errors, jobIds };
}

function main() {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};
  // `check:*` is not the whole gate surface: `verify:*` and `db:check-*` assert too, and eight of
  // them were unwired when this was widened. `db:push`/`db:studio`/`db:migrate` are tools, not
  // gates, so the prefix test is deliberately narrow.
  const isGate = (n) =>
    !HELPER.test(n) && (n.startsWith("check:") || n.startsWith("verify:") || n.startsWith("db:check-"));
  const gates = Object.keys(scripts).filter(isGate);

  const files = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({ file: f, text: readFileSync(join(WORKFLOWS, f), "utf8") }));

  const { runs, errors, jobIds } = collectRunSteps(files);

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`  UNPARSEABLE WORKFLOW: .github/workflows/${e.file} — ${e.message}`);
      console.error("    GitHub loads nothing from this file, so every gate it names is DEAD.");
      for (const h of e.hints)
        console.error(`    hint ${h.file}:${h.line} — a step name containing ": " must be quoted.\n      ${h.text}`);
    }
    console.error(`\ncheck-gate-wiring: ${errors.length} workflow file(s) do not parse.`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error("check-gate-wiring: read no workflow files — the scan is broken, not the repo.");
    process.exit(1);
  }
  if (gates.length < MIN_GATES) {
    console.error(`check-gate-wiring: resolved only ${gates.length} gates (floor ${MIN_GATES}) — the scan is broken, not the repo.`);
    process.exit(1);
  }
  if (jobIds.length < MIN_JOBS) {
    console.error(`check-gate-wiring: resolved only ${jobIds.length} jobs (floor ${MIN_JOBS}) — the scan is broken, not the repo.`);
    process.exit(1);
  }
  if (runs.length < MIN_RUN_STEPS) {
    console.error(`check-gate-wiring: resolved only ${runs.length} run steps (floor ${MIN_RUN_STEPS}) — the scan is broken, not the repo.`);
    process.exit(1);
  }

  const invoked = new Set();
  for (const step of runs) for (const token of shellTokens(step.run)) invoked.add(token);

  const unwired = gates.filter((g) => !invoked.has(g) && !(g in UNWIRED_BY_DESIGN));
  const staleExceptions = Object.keys(UNWIRED_BY_DESIGN).filter(
    (g) => !gates.includes(g) || invoked.has(g),
  );

  for (const g of staleExceptions)
    console.error(`  STALE EXCEPTION: ${g} — it is wired now, or no longer exists. Remove the entry.`);
  for (const g of unwired)
    console.error(`  UNWIRED: ${g} — no run: step of any job invokes it, so it can never run.`);

  if (unwired.length || staleExceptions.length) {
    console.error(
      `\ncheck-gate-wiring: ${unwired.length} unwired, ${staleExceptions.length} stale ` +
        `(searched ${runs.length} run steps across ${jobIds.length} jobs in ${files.length} workflow files).\n` +
        `Wire it into a run: step in .github/workflows/, or add it to UNWIRED_BY_DESIGN with the reason.`,
    );
    process.exit(1);
  }
  console.log(
    `check-gate-wiring: ${gates.length} gates, all invoked by a run: step ` +
      `(${runs.length} run steps across ${jobIds.length} jobs in ${files.length} workflow files, ` +
      `${Object.keys(UNWIRED_BY_DESIGN).length} deliberate exceptions).`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) main();
