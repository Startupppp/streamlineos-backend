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
  "check:hr-kb-invariants":
    "reconciles a live tenant database's knowledge-base links, attachments, sources and chunks " +
    "against its HR documents, so it needs HR_KB_DATABASE_URL pointing at real tenant data " +
    "(a table owner or BYPASSRLS role, which it makes explicit with row_security = off) and a hermetic " +
    "job has none. MEASURED 2026-09-25: exit 2 (INCONCLUSIVE, not a pass) with no URL, with an " +
    "unreadable database, and for an organisation with no documents. ci.yml runs its self-test " +
    "(48 assertions over the detector) and the DB-spec tier runs the real script against a seeded " +
    "database, planting each violation class. Owner: gate-wiring.",
  "check:timing-slo":
    "analyses a timing-sample FILE emitted by a live run, not the repository. It takes a " +
    "required --slo=<class> (ordinary-sql, complex-sql, ordinary-request, complex-request, " +
    "cache-hit) or --ceiling-ms=N plus a samples path, needs MIN_SAMPLES=3 and rejects a " +
    "sample set whose coefficient of variation exceeds 0.25, so there is nothing for a " +
    "hermetic job to point it at. MEASURED 2026-09-21: exit 2 with no argument, which is " +
    "INCONCLUSIVE and not a pass. Owner: gate-wiring.",
  "verify:razorpay-sandbox":
    "calls api.razorpay.com with real test-mode credentials, which no CI job holds. It " +
    "refuses any RAZORPAY_KEY_ID not beginning rzp_test_ before opening a socket, and exits 2 " +
    "(INCONCLUSIVE) rather than 0 when the credentials or the network are absent, so a silent " +
    "environment can never read as a pass. MEASURED 2026-09-08: 3/3 probes against the sandbox, " +
    "and exit 2 with no credentials. ci.yml names its self-test only, and says so. " +
    "Owner: gate-wiring.",

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

  "verify:auth-races":
    "requires AUTH_RACE_PROBE_DATABASE_URL — a dedicated disposable PostgreSQL it writes rows " +
    "to (users, verification_tokens, email_otp_codes). Proves concurrent-claim predicates at " +
    "READ COMMITTED isolation by racing two real connections; mocked specs model a predicate but " +
    "cannot race a row lock. Deliberately refuses DATABASE_URL and refuses any non-loopback " +
    "target without --allow-remote, so no hermetic CI job can satisfy it. " +
    "Owner: gate-wiring.",

  "verify:otp-delivery":
    "requires OTP_DELIVERY_PROBE_DATABASE_URL plus a booted API to trigger a real email send " +
    "(POST /auth/email-otp), and then a human to read the delivered inbox and supply " +
    "--confirm=<code>. The confirmation step is fundamentally interactive: the OTP is stored " +
    "only as a SHA-256 hash, so a CI job cannot fabricate the match without receiving the mail. " +
    "Owner: gate-wiring.",

  "verify:identity-journey":
    "requires JOURNEY_PROBE_DATABASE_URL (loopback-only), a booted API server at loopback, " +
    "INTERNAL_API_SECRET and NEXTAUTH_SECRET; drives real HTTP POST requests against the running " +
    "app and sleeps 16 seconds for the membership-status cache window to expire. No hermetic CI " +
    "job boots the application. Owner: gate-wiring.",

  "verify:qa-bug-contraction":
    "runs migrations/sql/b-qa-bug-03-verify.sql against the database named by a required --url and " +
    "refuses to run without one (exit 2), never reading .env because it resolves to the production " +
    "host. The hermetic gates job has no disposable database to point it at. Owner: gate-wiring.",

  "check:build-authz-census":
    "regenerates the committed Build authorization census reports in place, so running it in CI " +
    "would rewrite the tree rather than judge it. Its --check form, check:build-authz-census:check, " +
    "is the gate and runs in ci.yml after check:rbac-matrix-ledger. Owner: gate-wiring.",
});

/**
 * gate -> the reason it is invoked ONLY from steps that cannot fail their job.
 *
 * Added 2026-09-03 (v2 ticket 30). Until now this gate answered one question — is the gate
 * NAMED by a run: step of a reachable job — and treated that as "wired". It is not the same
 * question. A step carrying `continue-on-error: true` runs, prints, and then reports success
 * whatever it found: GitHub records the job as passing and the red is a grey annotation nobody
 * reads. Measured at head across the two repositories: 18 gate steps carried that flag, and six
 * of them exit 2 (INCONCLUSIVE, prerequisite absent) and 1 (a real defect) INDISTINGUISHABLY,
 * so a genuine finding could never fail CI. A gate that cannot fail is exactly the defect class
 * this file exists to close, and it was invisible to the file itself.
 *
 * `continue-on-error` on the JOB counts too: it makes every step in it non-blocking.
 *
 * An entry must name a MEASURED reason and an owner, the same discipline as UNWIRED_BY_DESIGN.
 * "flaky" and "not yet" are not reasons. The correct fix for a prerequisite-blocked gate is
 * usually not this list: it is to let the step distinguish exit 2 (prerequisite absent, warn)
 * from exit 1 (real finding, fail), which keeps the bite and still tolerates a missing sibling
 * checkout.
 */
const NON_BLOCKING_BY_DESIGN = Object.freeze({});


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

/**
 * Does this `continue-on-error:` value stop the step from failing its job?
 *
 * `true` and the string "true" plainly do. An EXPRESSION (`${{ github.event_name == 'push' }}`)
 * is answered conservatively as YES, because this gate must not certify a step as blocking on
 * the strength of a condition it cannot evaluate — the safe direction here is to demand a
 * registered reason, not to assume the step bites.
 */
export function isContinueOnError(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const inner = value.trim().replace(/^\$\{\{/, "").replace(/\}\}$/, "").trim().toLowerCase();
  return inner !== "false";
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
        // A step that cannot fail its job is not a gate, however well it is wired. The job's
        // own flag makes every step under it non-blocking, so both levels are consulted.
        const nonBlocking =
          isContinueOnError(step["continue-on-error"]) || isContinueOnError(job["continue-on-error"]);
        runs.push({
          file,
          job: jobId,
          name: typeof step.name === "string" ? step.name : "(unnamed)",
          run: step.run,
          nonBlocking,
        });
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
  const blocking = new Set();
  for (const step of runs)
    for (const token of shellTokens(step.run)) {
      invoked.add(token);
      if (!step.nonBlocking) blocking.add(token);
    }

  // Whole tokens per file, across every parsed workflow including the unreachable ones. An
  // exception that names a workflow is checked against this, not against prose.
  const tokensByFile = new Map();
  for (const step of declaredRuns) {
    let set = tokensByFile.get(step.file);
    if (!set) tokensByFile.set(step.file, (set = new Set()));
    for (const token of shellTokens(step.run)) set.add(token);
  }

  const unwired = gates.filter((g) => !invoked.has(g) && !(g in UNWIRED_BY_DESIGN));

  // Wired, reachable, and unable to fail. Every invocation of the gate sits in a step (or a job)
  // carrying `continue-on-error`, so CI runs it and then reports success regardless.
  const nonBlocking = gates.filter(
    (g) => invoked.has(g) && !blocking.has(g) && !(g in UNWIRED_BY_DESIGN) && !(g in NON_BLOCKING_BY_DESIGN),
  );
  const staleNonBlocking = Object.keys(NON_BLOCKING_BY_DESIGN).filter(
    (g) => !gates.includes(g) || blocking.has(g) || !invoked.has(g),
  );
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
  for (const g of nonBlocking)
    console.error(
      `  CANNOT FAIL: ${g} — every step invoking it carries \`continue-on-error\`, so CI reports ` +
        "success whatever it finds. Remove the flag, or split exit 2 (prerequisite absent) from " +
        "exit 1 (real finding), or register it in NON_BLOCKING_BY_DESIGN with a measured reason.",
    );
  for (const g of staleNonBlocking)
    console.error(
      `  STALE NON-BLOCKING EXCEPTION: ${g} — it is blocking now, unwired, or no longer exists. Remove the entry.`,
    );

  if (
    unwired.length ||
    nonBlocking.length ||
    staleNonBlocking.length ||
    staleExceptions.length ||
    unreachable.length ||
    deadJobs.length ||
    falseReasons.length
  ) {
    console.error(
      `\ncheck-gate-wiring: ${unwired.length} unwired, ${nonBlocking.length} cannot-fail, ` +
        `${staleNonBlocking.length} stale non-blocking, ${staleExceptions.length} stale, ` +
        `${falseReasons.length} false reason(s), ${unreachable.length} unreachable workflow(s), ` +
        `${deadJobs.length} dead job(s) ` +
        `(searched ${runs.length} run steps across ${jobIds.length} jobs in ${files.length} workflow files).\n` +
        `Wire it into a run: step of a workflow GitHub starts on its own, or add it to ` +
        `UNWIRED_BY_DESIGN with a reason that is true.`,
    );
    process.exit(1);
  }
  const blockingGates = gates.filter((g) => blocking.has(g)).length;
  console.log(
    `check-gate-wiring: ${gates.length} gates, ${blockingGates} of them able to FAIL the job ` +
      `(${Object.keys(NON_BLOCKING_BY_DESIGN).length} registered non-blocking), ` +
      `all invoked by a run: step of a reachable job ` +
      `(${runs.length} run steps across ${jobIds.length} jobs in ${files.length} workflow files, ` +
      `all ${files.length} reachable, ${Object.keys(UNWIRED_BY_DESIGN).length} deliberate exceptions).`,
  );
}

/**
 * Self-test. Added 2026-09-03 (v2 ticket 30).
 *
 * This gate had none — the gate that decides whether every other gate can run was itself
 * unproven, which is the recursion this file's own header spends forty lines warning about.
 * Every case below plants a defect in a synthetic workflow document and asserts the SPECIFIC
 * verdict, never merely a non-zero exit.
 */
export function runSelfTest() {
  const failures = [];
  let passed = 0;
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  const wf = (body) => [{ file: "t.yml", text: body }];
  const REACHABLE = "on:\n  push:\n    branches: [main]\n";
  const known = new Set(["main"]);

  // --- the corpus is collected at all ---
  const basic = collectRunSteps(
    wf(`${REACHABLE}jobs:\n  a:\n    steps:\n      - run: pnpm run check:one\n`),
    known,
  );
  assert("a reachable job's run step is collected", basic.runs.length === 1);
  assert("the collected step is not marked non-blocking by default", basic.runs[0].nonBlocking === false);
  assert("no spurious parse error on a well-formed file", basic.errors.length === 0);

  // --- continue-on-error, the rule this self-test was written for ---
  const stepFlag = collectRunSteps(
    wf(`${REACHABLE}jobs:\n  a:\n    steps:\n      - run: pnpm run check:one\n        continue-on-error: true\n`),
    known,
  );
  assert("a step-level continue-on-error marks the step non-blocking", stepFlag.runs[0].nonBlocking === true);

  const jobFlag = collectRunSteps(
    wf(`${REACHABLE}jobs:\n  a:\n    continue-on-error: true\n    steps:\n      - run: pnpm run check:one\n      - run: pnpm run check:two\n`),
    known,
  );
  assert(
    "a JOB-level continue-on-error marks EVERY step under it non-blocking",
    jobFlag.runs.length === 2 && jobFlag.runs.every((r) => r.nonBlocking === true),
  );

  const falseFlag = collectRunSteps(
    wf(`${REACHABLE}jobs:\n  a:\n    steps:\n      - run: pnpm run check:one\n        continue-on-error: false\n`),
    known,
  );
  assert("an explicit continue-on-error: false stays BLOCKING", falseFlag.runs[0].nonBlocking === false);

  assert("continue-on-error absent is blocking", isContinueOnError(undefined) === false);
  assert("continue-on-error: false is blocking", isContinueOnError(false) === false);
  assert('continue-on-error: "false" is blocking', isContinueOnError("false") === false);
  assert('an expression ${{ false }} is blocking', isContinueOnError("${{ false }}") === false);
  assert("continue-on-error: true is non-blocking", isContinueOnError(true) === true);
  assert(
    "an EXPRESSION this gate cannot evaluate is answered conservatively as non-blocking",
    isContinueOnError("${{ github.event_name == 'push' }}") === true,
  );

  // --- the three historical defects named in this file's header ---
  const comment = collectRunSteps(
    wf(`${REACHABLE}jobs:\n  a:\n    steps:\n      # pnpm run check:ghost\n      - run: pnpm run check:one\n`),
    known,
  );
  const commentTokens = new Set(comment.runs.flatMap((r) => shellTokens(r.run)));
  assert("a gate named only in a COMMENT is not counted as wired", commentTokens.has("check:ghost") === false);

  const unparseable = collectRunSteps(wf(`${REACHABLE}jobs:\n  a:\n    steps:\n      - name: A step: with a colon\n        run: pnpm run check:one\n`), known);
  assert("an unparseable workflow is an ERROR, never an empty success", unparseable.errors.length === 1);
  assert("an unparseable workflow contributes no run steps", unparseable.runs.length === 0);

  const selfTestOnly = collectRunSteps(
    wf(`${REACHABLE}jobs:\n  a:\n    steps:\n      - run: pnpm run check:one:self-test\n`),
    known,
  );
  const stTokens = new Set(selfTestOnly.runs.flatMap((r) => shellTokens(r.run)));
  assert(
    "a gate whose ONLY invocation is its own :self-test is not counted as wired",
    stTokens.has("check:one:self-test") === true && stTokens.has("check:one") === false,
  );

  // --- reachability and dead jobs ---
  const dispatchOnly = collectRunSteps(
    wf("on:\n  workflow_dispatch:\njobs:\n  a:\n    steps:\n      - run: pnpm run check:one\n"),
    known,
  );
  assert("a workflow_dispatch-only workflow is UNREACHABLE", dispatchOnly.unreachable.length === 1);
  assert("an unreachable workflow contributes no run steps", dispatchOnly.runs.length === 0);
  assert(
    "an unreachable workflow's steps are still recorded for exception-checking",
    dispatchOnly.declaredRuns.length === 1,
  );

  const cronless = collectRunSteps(
    wf("on:\n  schedule:\njobs:\n  a:\n    steps:\n      - run: pnpm run check:one\n"),
    known,
  );
  assert("a schedule with no cron is UNREACHABLE", cronless.unreachable.length === 1);

  const withCron = collectRunSteps(
    wf('on:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  a:\n    steps:\n      - run: pnpm run check:one\n'),
    known,
  );
  assert("a schedule WITH a cron is reachable", withCron.runs.length === 1);

  const deadJob = collectRunSteps(
    wf(`${REACHABLE}jobs:\n  a:\n    if: \${{ false }}\n    steps:\n      - run: pnpm run check:one\n`),
    known,
  );
  assert("a job pinned if: false is a DEAD JOB", deadJob.deadJobs.length === 1);
  assert("a dead job contributes no run steps", deadJob.runs.length === 0);

  const deadStep = collectRunSteps(
    wf(`${REACHABLE}jobs:\n  a:\n    steps:\n      - if: false\n        run: pnpm run check:one\n      - run: pnpm run check:two\n`),
    known,
  );
  assert("a step pinned if: false leaves the corpus", deadStep.runs.length === 1);

  const noBranch = collectRunSteps(
    wf("on:\n  push:\n    branches: [does-not-exist]\njobs:\n  a:\n    steps:\n      - run: pnpm run check:one\n"),
    known,
  );
  assert("a branches: filter matching no branch is UNREACHABLE", noBranch.unreachable.length === 1);

  // --- token splitting ---
  assert(
    "a && chain splits into whole tokens",
    (() => {
      const t = shellTokens("pnpm run check:a:self-test && pnpm run check:a");
      return t.includes("check:a") && t.includes("check:a:self-test");
    })(),
  );
  assert(
    "a gate name that is a PREFIX of another does not match it",
    shellTokens("pnpm run check:one-more").includes("check:one") === false,
  );

  // --- control: the real repository still passes, so a self-test cannot go green
  //     on fixtures while the live corpus is broken ---
  assert(
    "the real workflow corpus parses with no errors",
    (() => {
      const real = readdirSync(WORKFLOWS)
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
        .map((f) => ({ file: f, text: readFileSync(join(WORKFLOWS, f), "utf8") }));
      if (real.length === 0) return false;
      return collectRunSteps(real, knownBranchNames(REPO)).errors.length === 0;
    })(),
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-gate-wiring self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-gate-wiring self-tests: ${passed} passed`);
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  if (process.argv.includes("--self-test")) runSelfTest();
  main();
}
