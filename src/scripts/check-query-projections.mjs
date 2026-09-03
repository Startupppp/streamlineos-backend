#!/usr/bin/env node
/**
 * Gate: reads declare the columns they consume.
 *
 * Ticket 20's projection box has three clauses. Two of them — count paths and
 * existence paths — need no product decision at all, because a count and an
 * existence check have no response DTO: narrowing one changes no contract. They
 * were closed by hand in an earlier pass, and NOTHING was left enforcing them.
 * That pass found `survey_participants.accessTokenHash` — the hashed bearer
 * token that grants access to a survey response — hydrated into the Node heap to
 * answer a `.length`. There is no reason that cannot come back tomorrow.
 *
 * So this gate does two separate jobs, and it is important they stay separate:
 *
 *   1. HARD FAIL on an unprojected read whose result is only ever counted or
 *      tested for truthiness. That is the closed clause, and it is closed
 *      because no product owner has to agree to it.
 *
 *   2. RATCHET the population of unprojected list reads. That clause is BLOCKED
 *      on a product decision — narrowing `survey_questions.settings` or
 *      `automation_rules.conditions` changes the payload the endpoint exists to
 *      return, and no measurement can decide it. A ratchet is the honest thing
 *      to do with a blocked clause: it cannot close the box, but it stops the
 *      number climbing while the decision is outstanding, and it turns "roughly
 *      80% is unreachable" into a figure that is re-measured on every run.
 *
 * A projection is a top-level `columns:` key in the call's first object literal.
 * A `columns:` nested inside a `with:` projects the RELATION, not the row, so
 * brace depth is tracked rather than matched by regex.
 *
 * --self-test : run proof-of-failure fixtures and exit.
 * --emit      : rewrite the baseline from the current tree.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const BASELINE_FILE = new URL(
  "./baselines/query-projection-baseline.json",
  import.meta.url,
).pathname.replace(/^\/([A-Z]:)/, "$1");

const MIN_FILES = 2000;

/**
 * How far past the call to look for the consumers of its result.
 *
 * At 12 lines this reported `surveys/survey-export.service.ts:25` — where
 * `sessions.length` is tested twice for a truncation flag and the list itself is
 * consumed 20 and 35 lines later by `sessions.map` and `for (const session of
 * sessions)`. Seeing only the two `.length` tests, the scanner called an export
 * a count path.
 *
 * Widening this number can only ever REMOVE findings, never add one: a use is
 * disqualifying, so every extra line of window can only disqualify. That makes
 * the error it trades toward a false negative, which is the right direction for
 * a gate that hard-fails — and the deep hand-scan that closed this clause
 * already walked every site once. 80 lines covers the enclosing method in every
 * service in this repository bar the handful over the §7 500-line limit.
 */
const CONSUMER_LOOKFORWARD = 80;

const FIND_CALL = /\.query\.(\w+)\.(findMany|findFirst)\s*\(/g;
const BARE_SELECT = /\.select\s*\(\s*\)/g;

function collectSourceFiles(dir) {
  const files = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      files.push(...collectSourceFiles(full));
    } else if (
      stat.isFile() &&
      extname(entry) === ".ts" &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".e2e-spec.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

/**
 * The first object literal argument of the call starting at `open` (the index of
 * its `(`), returned with the depth of every key, so a top-level `columns:` can
 * be told apart from one inside `with:`. Strings and template literals are
 * skipped so a brace in `${...}` does not shift the depth.
 */
export function readCallArgument(src, open) {
  let depth = 0;
  let objectDepth = 0;
  let started = false;
  let inStr = false;
  let strChar = "";
  const keysAtDepthOne = [];
  let i = open;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === strChar && src[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strChar = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) break; }
    else if (ch === "{") { objectDepth++; started = true; }
    else if (ch === "}") objectDepth--;
    else if (started && objectDepth === 1 && /[A-Za-z_]/.test(ch)) {
      const rest = src.slice(i);
      const key = /^([A-Za-z_]\w*)\s*:/.exec(rest);
      if (key) { keysAtDepthOne.push(key[1]); i += key[1].length; }
    }
  }
  return { end: i, keysAtDepthOne, hasObjectArgument: started };
}

/**
 * The name the call's result is bound to, if any — `const rows = await db...`.
 * Only a `const`/`let` binding counts; an inlined call has no consumer to trace.
 */
function bindingBefore(src, callIndex) {
  const lineStart = src.lastIndexOf("\n", callIndex) + 1;
  const head = src.slice(lineStart, callIndex);
  const m = /(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*(?:await\s+)?[\w.$[\]()]*$/.exec(head.replace(/\s+/g, " "));
  return m ? m[1] : null;
}

/**
 * True when EVERY use of `name` after the call, within the lookforward window,
 * is `name.length`. Hydrating a whole row to answer a count is pure waste, and
 * in the worst case it lifts a secret column into the heap —
 * `survey_participants.accessTokenHash` was doing exactly that.
 *
 * Deliberately narrower than "count or truthiness". Allowing a BARE use as a
 * truthiness test measured 211 findings against a hand-scan's 4, because
 * `return rows;` is a bare use too and the whole list then read as a count. A
 * gate that fires on 211 sites of which 207 are wrong does not get fixed, it
 * gets an allowance — so the rule is the one thing that cannot be misread.
 *
 * Requiring EVERY use to be `.length`, rather than merely finding one, is what
 * keeps this off `dashboard-project.service.ts`, where the earlier hand-scan
 * attributed a `.length` to the wrong query and produced a false positive out of
 * four candidates.
 */
export function resultIsOnlyCounted(src, end, name) {
  const window = src.slice(end, end + 24000).split("\n").slice(0, CONSUMER_LOOKFORWARD).join("\n");
  const uses = [...window.matchAll(new RegExp(`\\b${name}\\b(\\s*[.?\\[]?\\s*\\w*)`, "g"))];
  if (uses.length === 0) return false;
  for (const use of uses) {
    const tail = use[1].replace(/\s+/g, "");
    if (tail === ".length" || tail === "?.length") continue;
    return false;
  }
  return true;
}

export function scanFile(src) {
  const findMany = [];
  const findFirst = [];
  const countPathsUnprojected = [];

  FIND_CALL.lastIndex = 0;
  let m;
  while ((m = FIND_CALL.exec(src)) !== null) {
    const open = src.indexOf("(", m.index + m[0].length - 1);
    const { end, keysAtDepthOne, hasObjectArgument } = readCallArgument(src, open);
    const projected = keysAtDepthOne.includes("columns");
    const line = src.slice(0, m.index).split("\n").length;
    const record = { line, table: m[1], kind: m[2] };
    if (!projected && hasObjectArgument) {
      (m[2] === "findMany" ? findMany : findFirst).push(record);
      const name = bindingBefore(src, m.index);
      if (name && resultIsOnlyCounted(src, end, name))
        countPathsUnprojected.push({ ...record, binding: name });
    }
    FIND_CALL.lastIndex = end;
  }

  BARE_SELECT.lastIndex = 0;
  const bareSelect = [...src.matchAll(BARE_SELECT)].map((s) => ({
    line: src.slice(0, s.index).split("\n").length,
  }));

  return { findMany, findFirst, bareSelect, countPathsUnprojected };
}

function loadBaseline() {
  try { return JSON.parse(readFileSync(BASELINE_FILE, "utf8")); } catch { return null; }
}

function runSelfTests() {
  const projectedCount = `
    const rows = await this.db.query.surveyParticipants.findMany({
      where: eq(surveyParticipants.orgId, orgId),
      columns: { status: true },
    });
    return rows.length;
  `;
  const unprojectedCount = `
    const rows = await this.db.query.surveyParticipants.findMany({
      where: eq(surveyParticipants.orgId, orgId),
    });
    return rows.length;
  `;
  const unprojectedList = `
    const rows = await this.db.query.surveyQuestions.findMany({
      where: eq(surveyQuestions.orgId, orgId),
      limit: 50,
    });
    return rows.map(toDto);
  `;
  const nestedColumnsOnly = `
    const rows = await this.db.query.tickets.findMany({
      where: eq(tickets.orgId, orgId),
      with: { assignee: { columns: { id: true } } },
    });
    return rows.length;
  `;

  const cases = [
    ["a projected count path is not a finding", projectedCount, 0],
    ["an unprojected count path IS a finding", unprojectedCount, 1],
    ["an unprojected LIST path is not a count finding (it is the blocked clause)", unprojectedList, 0],
    ["a columns: nested inside with: does not count as a projection", nestedColumnsOnly, 1],
  ];
  for (const [label, fixture, expected] of cases) {
    const got = scanFile(fixture).countPathsUnprojected.length;
    if (got !== expected) {
      console.error(`SELF-TEST FAIL: ${label} — expected ${expected}, got ${got}`);
      process.exit(1);
    }
  }

  if (scanFile(unprojectedList).findMany.length !== 1) {
    console.error("SELF-TEST FAIL: an unprojected findMany was not counted in the ratchet population");
    process.exit(1);
  }
  if (scanFile(projectedCount).findMany.length !== 0) {
    console.error("SELF-TEST FAIL: a projected findMany leaked into the ratchet population");
    process.exit(1);
  }
  if (scanFile("const r = await db.select().from(t);").bareSelect.length !== 1) {
    console.error("SELF-TEST FAIL: a bare .select() was not counted");
    process.exit(1);
  }
  if (scanFile("const r = await db.select({ id: t.id }).from(t);").bareSelect.length !== 0) {
    console.error("SELF-TEST FAIL: a projected .select({...}) was counted as bare");
    process.exit(1);
  }

  // resultIsOnlyCounted must require EVERY use to be a count. One `.length`
  // beside a real read is a list path, not a count path — this is the shape that
  // produced the earlier hand-scan's false positive.
  const mixedUse = `
    const rows = await this.db.query.t.findMany({ where: w });
    log(rows.length);
    return rows.map((r) => r.name);
  `;
  if (scanFile(mixedUse).countPathsUnprojected.length !== 0) {
    console.error("SELF-TEST FAIL: a result used for BOTH a count and a read was called a count path");
    process.exit(1);
  }

  const files = collectSourceFiles(ROOT);
  if (files.length < MIN_FILES) {
    console.error(`SELF-TEST FAIL: discovered only ${files.length} source files (expected >= ${MIN_FILES}) — ROOT is wrong: ${ROOT}`);
    process.exit(1);
  }

  console.log("SELF-TEST PASS: all 10 projection checks passed");
}

function main() {
  if (process.argv.includes("--self-test")) { runSelfTests(); return; }

  const files = collectSourceFiles(ROOT);
  if (files.length < MIN_FILES) {
    console.error(`ERROR: only ${files.length} source files found (expected >= ${MIN_FILES}) — ROOT is wrong: ${ROOT}`);
    process.exitCode = 1;
    return;
  }

  const totals = { findMany: 0, findFirst: 0, bareSelect: 0 };
  const countPaths = [];
  for (const file of files) {
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    const r = scanFile(src);
    totals.findMany += r.findMany.length;
    totals.findFirst += r.findFirst.length;
    totals.bareSelect += r.bareSelect.length;
    const rel = file.slice(ROOT.length - 1);
    for (const c of r.countPathsUnprojected)
      countPaths.push(`${rel}:${c.line} (${c.kind} on ${c.table}, consumed only as ${c.binding}.length)`);
  }

  if (process.argv.includes("--emit")) {
    writeFileSync(
      BASELINE_FILE,
      JSON.stringify(
        { version: 1, measuredAt: new Date().toISOString().slice(0, 10), files: files.length,
          note: "Ratchets for ticket 20's projection box. countPathsAllowed is the CLOSED clause and must stay at 0; the three population ceilings hold the BLOCKED clause from growing while the product decision is outstanding. All four may only go DOWN.",
          countPathsAllowed: countPaths.length, ...totals },
        null, 2,
      ) + "\n",
    );
    console.log(`Wrote ${BASELINE_FILE}`);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error(`ERROR: no baseline at ${BASELINE_FILE} — run with --emit once and review the numbers.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Scanned ${files.length} source files.`);
  console.log(`Unprojected reads — findMany ${totals.findMany} (ceiling ${baseline.findMany}) · findFirst ${totals.findFirst} (ceiling ${baseline.findFirst}) · bare .select() ${totals.bareSelect} (ceiling ${baseline.bareSelect}).`);
  console.log(`Unprojected COUNT/EXISTENCE paths: ${countPaths.length} (allowed ${baseline.countPathsAllowed}).`);

  let failed = false;

  if (countPaths.length > baseline.countPathsAllowed) {
    console.error(
      `\n${countPaths.length} unprojected count/existence path(s) against an allowance of ${baseline.countPathsAllowed}. A count has no response DTO, so narrowing it changes no contract and needs no product decision — this is the clause ticket 20 CLOSED, and closing it is what stopped survey_participants.accessTokenHash being hydrated to answer a .length:`,
    );
    for (const c of countPaths) console.error(`  UNPROJECTED-COUNT  ${c}`);
    failed = true;
  }

  for (const key of ["findMany", "findFirst", "bareSelect"]) {
    if (totals[key] > baseline[key]) {
      console.error(
        `\nRATCHET BREACH: ${key} unprojected reads rose ${baseline[key]} -> ${totals[key]}. This clause is BLOCKED on a product decision about which list endpoints may return less, so it is not required to fall — but it may not climb while that decision is outstanding.`,
      );
      failed = true;
    }
  }

  if (!failed)
    console.log("\nNo unprojected count/existence path, and no population ceiling breached.");

  process.exitCode = failed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) main();
