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
 *
 * ---------------------------------------------------------------------------------------------
 * 2026-09-03 (later the same day) — PARSING IS NOT ENOUGH EITHER. THE WORKFLOW MUST BE REACHABLE.
 *
 * Fourth instance of the same class, and the one this section exists for. `db-gates.yml` parsed
 * perfectly, named its gates in real `run:` steps, and this gate reported all of them wired —
 * while the file carried `on: { schedule, workflow_dispatch }` and nothing else, so no push and
 * no pull request has ever run a single one of them. Its own header said so in prose. Measured:
 * its entire GitHub Actions history was ONE scheduled run, `33733281657`, and all three jobs
 * FAILED at the first database step. A gate whose only trigger is a nightly nobody reads is a
 * gate in name only, and a gate whose only trigger is `workflow_dispatch` is not even that.
 *
 * So `run:` membership is now necessary and not sufficient. A workflow contributes its steps to
 * the wired set only when GitHub will start it WITHOUT a human:
 *
 *   - no `on:` at all, or an empty one                       -> UNREACHABLE
 *   - only `workflow_dispatch` / `repository_dispatch`       -> UNREACHABLE (a human must click)
 *   - `schedule:` with no `cron:` entry                      -> that event cannot fire
 *   - `push:`/`pull_request:` whose `branches:` filter matches no branch this repository
 *     has                                                    -> that event cannot fire
 *   - a job pinned `if: false` (or `if: ${{ false }}`)       -> DEAD JOB, its steps do not count
 *
 * An unreachable workflow and a dead job each fail this gate by name, exactly like an unwired
 * gate, and their run steps leave the corpus — so a gate that lived only there also reports
 * UNWIRED rather than quietly passing.
 */
import { execFileSync } from "node:child_process";
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
  // `check:declaration-column-drift` and `check:declaration-constraint-drift` used to sit here.
  // Their reasons claimed "runs in db-gates.yml when a bootstrapped target exists"; neither name
  // appeared anywhere in db-gates.yml, so both were plainly unwired under a reason that read as a
  // deliberate choice. Both now have real steps in db-gates.yml's `bootstrapped` job, measured
  // exit 0 against a database at journal head 672/672. FALSE EXCEPTION REASON below is the check
  // that makes this class of entry impossible to write again.

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
 * itself on zero unwired gates. Re-measured 2026-09-03 after db-gates.yml was repaired and
 * wired onto push and pull_request: 98 gates, 15 jobs, 158 run steps across the 7 workflow
 * files, all 7 reachable. The floors sit roughly 25% below each, so a legitimate deletion does
 * not trip them but a matcher that stops resolving does — including the new way of resolving
 * nothing, which is every workflow being ruled unreachable.
 */
const MIN_GATES = 90;
const MIN_JOBS = 11;
const MIN_RUN_STEPS = 118;

/**
 * Events GitHub starts on its own. `workflow_dispatch` and `repository_dispatch` are
 * deliberately absent: they need a human (or an external caller) to press the button, and a
 * gate nobody presses is not a gate. `workflow_call` is absent for the same reason at one
 * remove — the caller decides, and the caller is checked on its own terms.
 */
const AUTOMATIC_EVENTS = new Set([
  "push",
  "pull_request",
  "pull_request_target",
  "schedule",
  "merge_group",
  "release",
  "issue_comment",
  "issues",
  "check_run",
  "check_suite",
  "create",
  "delete",
  "deployment",
  "deployment_status",
  "fork",
  "label",
  "milestone",
  "page_build",
  "project",
  "project_card",
  "project_column",
  "public",
  "pull_request_review",
  "pull_request_review_comment",
  "registry_package",
  "status",
  "watch",
  "workflow_run",
]);

/** Events whose `branches:` / `branches-ignore:` filter decides whether they can ever fire. */
const BRANCH_FILTERED = new Set(["push", "pull_request", "pull_request_target"]);

/**
 * This repository's branch names, used to answer "can this `branches:` filter ever match?".
 * The default branch is always in the set; git supplies the rest when it can. A filter that
 * matches nothing here is reported, so the set erring wide is the safe direction.
 */
export function knownBranchNames(repo) {
  const names = new Set(["main"]);
  for (const v of [process.env.GITHUB_REF_NAME, process.env.GITHUB_BASE_REF, process.env.GITHUB_HEAD_REF])
    if (typeof v === "string" && v) names.add(v);
  try {
    const out = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const raw of out.split("\n")) {
      const name = raw.trim();
      if (!name || name.endsWith("/HEAD")) continue;
      names.add(name);
      const slash = name.indexOf("/");
      if (slash > 0) names.add(name.slice(slash + 1));
    }
  } catch {
    // No git, or no refs. The default branch alone still answers the common filters.
  }
  return names;
}

/** GitHub filter-pattern match: `**` crosses `/`, `*` and `?` do not. */
export function matchesFilterPattern(pattern, name) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(name);
}

/** True when a `branches:` / `branches-ignore:` list lets at least one known branch through. */
export function branchFilterCanMatch(list, knownBranches, isIgnore) {
  if (list === undefined || list === null) return true;
  const patterns = (Array.isArray(list) ? list : [list]).filter((p) => typeof p === "string");
  if (patterns.length === 0) return false;
  for (const branch of knownBranches) {
    let allowed = isIgnore;
    for (const pattern of patterns) {
      const negated = pattern.startsWith("!");
      const body = negated ? pattern.slice(1) : pattern;
      if (!matchesFilterPattern(body, branch)) continue;
      allowed = isIgnore ? negated : !negated;
    }
    if (allowed) return true;
  }
  return false;
}

/** Can this one event ever start the workflow by itself? Returns null when it can. */
export function eventCannotFire(event, config, knownBranches) {
  if (!AUTOMATIC_EVENTS.has(event)) return `${event} needs a human or an external caller`;
  // `schedule:` is the one event whose bare form fires nothing: it is a list of crons, so an
  // absent or empty list is a trigger that can never come round. Checked before the null guard
  // below, which is otherwise correct — `pull_request:` with no body fires on every PR.
  if (event === "schedule") return "schedule carries no cron entry";
  if (config === null || config === undefined) return null;
  if (typeof config !== "object" || Array.isArray(config)) return null;

  if (Array.isArray(config.types) && config.types.length === 0)
    return `${event} declares an empty types: list`;

  if (BRANCH_FILTERED.has(event)) {
    if (!branchFilterCanMatch(config.branches, knownBranches, false))
      return `${event} branches: ${JSON.stringify(config.branches)} matches no branch in this repository`;
    if (!branchFilterCanMatch(config["branches-ignore"], knownBranches, true))
      return `${event} branches-ignore: ${JSON.stringify(config["branches-ignore"])} excludes every branch in this repository`;
  }
  return null;
}

/**
 * Why, or whether, GitHub will ever start this workflow without a human.
 * Returns `{ fires: true }` or `{ fires: false, reason }`.
 */
export function workflowReachability(wf, knownBranches) {
  const triggers = wf.on !== undefined ? wf.on : wf.true;
  if (triggers === null || triggers === undefined)
    return { fires: false, reason: "declares no `on:` triggers, so GitHub never starts it" };

  let entries;
  if (typeof triggers === "string") entries = [[triggers, null]];
  else if (Array.isArray(triggers)) entries = triggers.map((e) => [String(e), null]);
  else if (typeof triggers === "object") entries = Object.entries(triggers);
  else return { fires: false, reason: `\`on:\` is ${typeof triggers}, which declares no trigger` };

  if (entries.length === 0)
    return { fires: false, reason: "declares an empty `on:` block, so GitHub never starts it" };

  const blocked = [];
  for (const [event, config] of entries) {
    const scheduleWithCron =
      event === "schedule" &&
      Array.isArray(config) &&
      config.some((e) => e !== null && typeof e === "object" && typeof e.cron === "string" && e.cron.trim());
    if (scheduleWithCron) return { fires: true };
    const why = eventCannotFire(event, config, knownBranches);
    if (why === null) return { fires: true };
    blocked.push(why);
  }
  return {
    fires: false,
    reason: `no trigger can fire automatically — ${blocked.join("; ")}`,
  };
}

/**
 * A job or step pinned off. `if: false` parses as a boolean; `if: ${{ false }}` does not, and
 * that spelling is how a step stays in the file while never executing.
 */
export function isAlwaysFalse(value) {
  if (value === false) return true;
  if (typeof value !== "string") return false;
  const inner = value
    .trim()
    .replace(/^\$\{\{/, "")
    .replace(/\}\}$/, "")
    .trim()
    .toLowerCase();
  return inner === "false";
}

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
export function collectRunSteps(files, knownBranches = new Set(["main"])) {
  const runs = [];
  const declaredRuns = [];
  const errors = [];
  const jobIds = [];
  const unreachable = [];
  const deadJobs = [];

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

    // A file GitHub never starts contributes nothing, however well it parses. Its steps leave
    // the corpus, so a gate that lived only there reports UNWIRED instead of passing on paper.
    const reach = workflowReachability(wf, knownBranches);

    // Recorded for every parsed file, reachable or not: it is the evidence an exception's
    // stated reason is checked against, and a claim about a dead file must still be testable.
    for (const [jobId, job] of Object.entries(wf.jobs)) {
      if (job === null || typeof job !== "object" || Array.isArray(job)) continue;
      if (!Array.isArray(job.steps)) continue;
      for (const step of job.steps) {
        if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
        if (typeof step.run === "string") declaredRuns.push({ file, job: jobId, run: step.run });
      }
    }

    if (!reach.fires) {
      unreachable.push({ file, reason: reach.reason });
      continue;
    }

    for (const [jobId, job] of Object.entries(wf.jobs)) {
      if (job !== null && typeof job === "object" && !Array.isArray(job) && isAlwaysFalse(job.if)) {
        deadJobs.push({ file, job: jobId });
        continue;
      }
      jobIds.push(`${file}:${jobId}`);
      if (job === null || typeof job !== "object" || Array.isArray(job)) continue;
      // A `uses:` job calls a reusable workflow and has no steps of its own; that is not an error.
      if (!Array.isArray(job.steps)) continue;
      for (const step of job.steps) {
        if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
        if (typeof step.run !== "string") continue;
        // `if: false` is a step pinned off. It is in the file and it never executes.
        if (isAlwaysFalse(step.if)) continue;
        runs.push({ file, job: jobId, name: typeof step.name === "string" ? step.name : "(unnamed)", run: step.run });
      }
    }
  }

  return { runs, declaredRuns, errors, jobIds, unreachable, deadJobs };
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

  const knownBranches = knownBranchNames(REPO);
  const { runs, declaredRuns, errors, jobIds, unreachable, deadJobs } = collectRunSteps(
    files,
    knownBranches,
  );

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

  // Whole tokens per file, across every parsed workflow including the unreachable ones. An
  // exception that names a workflow is checked against this, not against prose.
  const tokensByFile = new Map();
  for (const step of declaredRuns) {
    let set = tokensByFile.get(step.file);
    if (!set) tokensByFile.set(step.file, (set = new Set()));
    for (const token of shellTokens(step.run)) set.add(token);
  }

  const unwired = gates.filter((g) => !invoked.has(g) && !(g in UNWIRED_BY_DESIGN));
  const staleExceptions = Object.keys(UNWIRED_BY_DESIGN).filter(
    (g) => !gates.includes(g) || invoked.has(g),
  );

  // A reason that says "runs in <file>.yml" is a factual claim. Both entries this check was
  // written for — `check:declaration-column-drift` and `check:declaration-constraint-drift` —
  // claimed db-gates.yml ran them and db-gates.yml never named either. An UNWIRED_BY_DESIGN
  // reason that is not true is worse than no exception: it launders a dead gate as a choice.
  //
  // A named workflow satisfies the claim if any run: step there invokes the gate OR one of its
  // sub-commands (`check:alert-ack` is legitimately described by "ci.yml names the self-test
  // only"). What it may not do is name a file that has never heard of the gate at all.
  const falseReasons = [];
  for (const [gate, reason] of Object.entries(UNWIRED_BY_DESIGN)) {
    for (const named of new Set(reason.match(/[A-Za-z0-9._-]+\.ya?ml/g) ?? [])) {
      const tokens = tokensByFile.get(named);
      if (tokens === undefined) {
        falseReasons.push(`${gate} — its reason names ${named}, which is not a workflow file here`);
        continue;
      }
      const mentioned = [...tokens].some((t) => t === gate || t.startsWith(`${gate}:`));
      if (!mentioned)
        falseReasons.push(
          `${gate} — its reason points at ${named}, and no run: step there names the gate in any form`,
        );
    }
  }

  for (const w of unreachable)
    console.error(
      `  UNREACHABLE WORKFLOW: .github/workflows/${w.file} — ${w.reason}.\n` +
        "    Every gate named only here is dead, whatever the file says.",
    );
  for (const j of deadJobs)
    console.error(
      `  DEAD JOB: .github/workflows/${j.file}:${j.job} — pinned \`if: false\`, so it never runs.`,
    );
  for (const f of falseReasons) console.error(`  FALSE EXCEPTION REASON: ${f}.`);
  for (const g of staleExceptions)
    console.error(`  STALE EXCEPTION: ${g} — it is wired now, or no longer exists. Remove the entry.`);
  for (const g of unwired)
    console.error(`  UNWIRED: ${g} — no run: step of any reachable job invokes it, so it can never run.`);

  if (unwired.length || staleExceptions.length || unreachable.length || deadJobs.length || falseReasons.length) {
    console.error(
      `\ncheck-gate-wiring: ${unwired.length} unwired, ${staleExceptions.length} stale, ` +
        `${falseReasons.length} false reason(s), ${unreachable.length} unreachable workflow(s), ` +
        `${deadJobs.length} dead job(s) ` +
        `(searched ${runs.length} run steps across ${jobIds.length} jobs in ${files.length} workflow files).\n` +
        `Wire it into a run: step of a workflow GitHub starts on its own, or add it to ` +
        `UNWIRED_BY_DESIGN with a reason that is true.`,
    );
    process.exit(1);
  }
  console.log(
    `check-gate-wiring: ${gates.length} gates, all invoked by a run: step of a reachable job ` +
      `(${runs.length} run steps across ${jobIds.length} jobs in ${files.length} workflow files, ` +
      `all ${files.length} reachable, ${Object.keys(UNWIRED_BY_DESIGN).length} deliberate exceptions).`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) main();
