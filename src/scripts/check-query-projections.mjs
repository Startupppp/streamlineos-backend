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
import { join, extname, sep } from "node:path";
import {
  scanExistencePaths,
  scanHeavyColumnReads,
  collectHeavyColumnTables,
  OUT_OF_RELEASE_SCOPE,
} from "./existence-paths.mjs";
import { scanCountExistenceProbes } from "./count-existence-probes.mjs";

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

  /* --- the AST existence rule: it must draw the distinction the regex cannot --- */
  const ex = (label, fixture, expected) => {
    const got = scanExistencePaths("src/modules/x/y.service.ts", fixture).length;
    if (got !== expected) {
      console.error(`SELF-TEST FAIL: ${label} — expected ${expected}, got ${got}`);
      process.exit(1);
    }
  };

  ex(
    "an unprojected findFirst used only as a null guard IS a finding",
    `const row = await this.db.query.signRecipients.findFirst({ where: w });
     if (!row) throw new BadRequestException("nope");`,
    1,
  );
  ex(
    "the same read, projected, is not a finding",
    `const row = await this.db.query.signRecipients.findFirst({ columns: { id: true }, where: w });
     if (!row) throw new BadRequestException("nope");`,
    0,
  );
  // This is the case the sibling gate's regex cannot separate from the one above,
  // and why it measured 211 findings where a hand-scan found 4.
  ex(
    "a returned row is NOT an existence path even though the guard looks identical",
    `const row = await this.db.query.signRecipients.findFirst({ where: w });
     if (!row) throw new BadRequestException("nope");
     return row;`,
    0,
  );
  ex(
    "reading one property off the row disqualifies the site",
    `const row = await this.db.query.signRecipients.findFirst({ where: w });
     if (!row) throw new BadRequestException("nope");
     this.log(row.email);`,
    0,
  );
  ex(
    "a bare .select() consumed only as .length IS a finding",
    `const existing = await this.db.select().from(t).where(w).limit(1);
     if (existing.length === 0) throw new NotFoundException("gone");`,
    1,
  );
  // The shape /\.select\s*\(\s*\)/ cannot see at all.
  ex(
    ".select(getTableColumns(t)) is a full-row read, not a projection",
    `const existing = await this.db.select(getTableColumns(t)).from(t).where(w);
     if (!existing) throw new NotFoundException("gone");`,
    1,
  );
  ex(
    "a genuinely projected .select() is not a finding",
    `const existing = await this.db.select({ id: t.id }).from(t).where(w).limit(1);
     if (existing.length === 0) throw new NotFoundException("gone");`,
    0,
  );
  ex(
    "a row nobody references at all is not reported here",
    `const row = await this.db.query.signRecipients.findFirst({ where: w });
     return 1;`,
    0,
  );

  /* --- the vector/tsvector/bytea rule --- */
  const heavy = new Map([["kbPages", ["fts:tsvector"]], ["kbArticleChunks", ["embedding:vector"]]]);
  const hv = (label, fixture, expected) => {
    const got = scanHeavyColumnReads("src/modules/kb/x.service.ts", fixture, heavy).length;
    if (got !== expected) {
      console.error(`SELF-TEST FAIL: ${label} — expected ${expected}, got ${got}`);
      process.exit(1);
    }
  };
  hv("a bare .select() from a tsvector table IS a finding",
     "const p = await tx.select().from(kbPages).where(w);", 1);
  hv("naming the columns is not a finding",
     "const p = await tx.select(KB_PAGE_COLUMNS).from(kbPages).where(w);", 0);
  hv("an unprojected db.query read of a vector table IS a finding",
     "const c = await this.db.query.kbArticleChunks.findMany({ where: w });", 1);
  hv("excluding the heavy column is not a finding",
     "const c = await this.db.query.kbArticleChunks.findMany({ columns: { embedding: false }, where: w });", 0);
  hv("a table with no heavy column is not a finding",
     "const t = await tx.select().from(kbTags).where(w);", 0);

  const resolved = collectHeavyColumnTables(
    (f) => readFileSync(f, "utf8"),
    collectSourceFiles(ROOT).filter((f) => f.includes(`${sep}db${sep}schema${sep}`)),
  );
  if (resolved.size === 0) {
    console.error("SELF-TEST FAIL: resolved no vector/tsvector/bytea table from the real schema");
    process.exit(1);
  }

  if (!OUT_OF_RELEASE_SCOPE.test("src/modules/inventory/replenishment/inv.service.ts")) {
    console.error("SELF-TEST FAIL: inventory not recognised as out of release scope");
    process.exit(1);
  }
  if (OUT_OF_RELEASE_SCOPE.test("src/modules/hr/directory/assets.service.ts")) {
    console.error("SELF-TEST FAIL: hr wrongly treated as out of release scope");
    process.exit(1);
  }

  const files = collectSourceFiles(ROOT);
  /* --- PRD-C073: the COUNT half of the existence clause --- */
  const cp = (label, fixture, expected) => {
    const got = scanCountExistenceProbes("src/modules/x/y.service.ts", fixture).length;
    if (got !== expected) {
      console.error(`SELF-TEST FAIL: ${label} — expected ${expected}, got ${got}`);
      process.exit(1);
    }
  };

  cp(
    "a count() compared only against 0 IS an unbounded existence probe",
    `const [row] = await this.db.select({ total: count() }).from(journalEntries).where(w);
     if ((row?.total ?? 0) > 0) throw new ConflictException("nope");`,
    1,
  );
  cp(
    "the same probe with .limit(1) is not a finding",
    `const rows = await this.db.select({ one: sql\`1\` }).from(journalEntries).where(w).limit(1);
     if (rows.length > 0) throw new ConflictException("nope");`,
    0,
  );
  cp(
    "a count() whose value ESCAPES is a real count, not a probe",
    `const [row] = await this.db.select({ total: count() }).from(journalEntries).where(w);
     if ((row?.total ?? 0) > 0) this.log(row.total);
     return row?.total ?? 0;`,
    0,
  );
  cp(
    "a count() compared against a business threshold is not an existence probe",
    `const [row] = await this.db.select({ total: count() }).from(seats).where(w);
     if ((row?.total ?? 0) > 25) throw new ConflictException("seat limit");`,
    0,
  );
  cp(
    "Number(...) around the value does not hide the probe",
    `const [row] = await this.db.select({ cnt: count() }).from(roleAssignments).where(w);
     if (Number(row?.cnt ?? 0) > 0) throw new ConflictException("in use");`,
    1,
  );
  // The attribution bug this rule was written through: sixteen sibling probes inside one
  // Promise.all must report as sixteen findings on sixteen bindings, not as 16 x 16.
  cp(
    "each element of a destructured Promise.all lands on its OWN binding",
    `const [a, b] = await Promise.all([
       this.countRows(this.db.select({ value: count() }).from(orgUnits).where(w)),
       this.countRows(this.db.select({ value: count() }).from(hrPositions).where(w)),
     ]);
     return { x: a > 0, y: b > 0 };`,
    2,
  );

  if (files.length < MIN_FILES) {
    console.error(`SELF-TEST FAIL: discovered only ${files.length} source files (expected >= ${MIN_FILES}) — ROOT is wrong: ${ROOT}`);
    process.exit(1);
  }

  console.log(`SELF-TEST PASS: all 32 projection checks passed (${resolved.size} heavy-column tables resolved from the real schema)`);
}

function main() {
  if (process.argv.includes("--self-test")) { runSelfTests(); return; }

  const files = collectSourceFiles(ROOT);
  if (files.length < MIN_FILES) {
    console.error(`ERROR: only ${files.length} source files found (expected >= ${MIN_FILES}) — ROOT is wrong: ${ROOT}`);
    process.exitCode = 1;
    return;
  }

  const heavyTables = collectHeavyColumnTables(
    (f) => readFileSync(f, "utf8"),
    files.filter((f) => f.includes(`${sep}db${sep}schema${sep}`)),
  );
  if (heavyTables.size === 0) {
    console.error("ERROR: resolved no table with a vector/tsvector/bytea column — the schema scan is broken, not the repo.");
    process.exitCode = 1;
    return;
  }

  const totals = { findMany: 0, findFirst: 0, bareSelect: 0 };
  const countPaths = [];
  const existenceInScope = [];
  const existenceDeferred = [];
  const countProbesInScope = [];
  const countProbesDeferred = [];
  const heavyReads = [];
  for (const file of files) {
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    const r = scanFile(src);
    totals.findMany += r.findMany.length;
    totals.findFirst += r.findFirst.length;
    totals.bareSelect += r.bareSelect.length;
    const rel = file.slice(ROOT.length - 1).replace(/\\/g, "/");
    for (const c of r.countPathsUnprojected)
      countPaths.push(`${rel}:${c.line} (${c.kind} on ${c.table}, consumed only as ${c.binding}.length)`);
    for (const h of scanHeavyColumnReads(rel, src, heavyTables))
      heavyReads.push(`${h.file}:${h.line} (${h.shape} on ${h.table}, hydrates ${h.columns.join(", ")})`);
    for (const e of scanExistencePaths(rel, src))
      (OUT_OF_RELEASE_SCOPE.test(rel) ? existenceDeferred : existenceInScope).push(
        `${e.file}:${e.line} (${e.shape} on ${e.subject}, ${e.binding} only ${e.kind}-tested)`,
      );
    for (const c of scanCountExistenceProbes(rel, src))
      (OUT_OF_RELEASE_SCOPE.test(rel) ? countProbesDeferred : countProbesInScope).push(
        `${c.file}:${c.line} (count() on ${c.table}, ${c.binding} only compared against an existence threshold, no LIMIT)`,
      );
  }

  if (process.argv.includes("--emit")) {
    writeFileSync(
      BASELINE_FILE,
      JSON.stringify(
        { version: 1, measuredAt: new Date().toISOString().slice(0, 10), files: files.length,
          note: "Ratchets for ticket 20's projection box. countPathsAllowed and existencePathsAllowed are the CLOSED clauses and must stay at 0; the three population ceilings hold the BLOCKED clause from growing while the product decision is outstanding. existenceDeferredAllowed covers the modules excluded from this release (crm/leads/deals/contacts/inventory) — enforced as a ratchet so they cannot grow before the exclusion lifts. All may only go DOWN.",
          countPathsAllowed: countPaths.length,
          existencePathsAllowed: existenceInScope.length,
          existenceDeferredAllowed: existenceDeferred.length,
          heavyColumnReadsAllowed: heavyReads.length, ...totals,
          measuredAgainst:
            "git archive HEAD src — NOT the working tree. Measured on the dirty tree first and it read 294/547/600 against HEAD's 295/547/599, because two concurrent lanes held uncommitted edits in opposite directions (one projecting chat/chat-channel-list.service.ts, one adding a bare .select()). A ceiling taken from a shared dirty tree is not the number the gate will see." },
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
  console.log(`Unprojected reads — findMany ${totals.findMany} · findFirst ${totals.findFirst} · bare .select() ${totals.bareSelect} = ${totals.findMany + totals.findFirst + totals.bareSelect} (ceiling ${baseline.findMany + baseline.findFirst + baseline.bareSelect}, enforced on the total).`);
  console.log(`Unprojected COUNT paths (.length only): ${countPaths.length} (allowed ${baseline.countPathsAllowed}).`);
  console.log(`Unprojected EXISTENCE/COUNT paths, AST: ${existenceInScope.length} in scope (allowed ${baseline.existencePathsAllowed ?? 0}) · ${existenceDeferred.length} deferred to crm/inventory (ratchet ${baseline.existenceDeferredAllowed ?? 0}).`);
  console.log(`Full-row reads of a vector/tsvector/bytea table: ${heavyReads.length} (allowed ${baseline.heavyColumnReadsAllowed ?? 0}) over ${heavyTables.size} such tables.`);
  console.log(`Unbounded COUNT existence probes (count() vs 0/1, no LIMIT): ${countProbesInScope.length} in scope (allowed 0) · ${countProbesDeferred.length} deferred to crm/inventory (reported, not enforced).`);

  // The deferred buckets were said to be "printed so it cannot hide", but only
  // printed on a ratchet BREACH — so a sitting population was invisible to
  // anyone trying to work it down, which is the opposite of a ratchet's point.
  // `--list` names them without waiting for the count to grow.
  if (process.argv.includes("--list")) {
    for (const e of existenceDeferred) console.log(`  DEFERRED-EXISTENCE     ${e}`);
    for (const c of countProbesDeferred) console.log(`  DEFERRED-COUNT-PROBE   ${c}`);
  }

  let failed = false;

  /**
   * PRD-C073's other half, in its own words: "do not fetch records or COUNTS when
   * only existence is required". Everything above this rule covers records. Nothing
   * covered counts, and the count is the more expensive shape — a record read is
   * bounded by the row, but `select({ total: count() }).from(t).where(org, status)`
   * aggregates the tenant's whole matching history to answer a yes/no question.
   * Measured at head: accounting-settings.service.ts counted every POSTED journal
   * entry in the organisation to decide whether the base currency may still change.
   *
   * Enforced at a LITERAL zero, with no baseline key, deliberately. The population
   * was 21 in scope when this rule was written and all 21 were rewritten as
   * `select({ one: sql`1` }) ... .limit(1)` in the same commit, so there is nothing
   * to ratchet down from — and a rule with no baseline entry cannot be relaxed by
   * re-emitting the baseline. Narrowing one of these changes no response DTO: the
   * count is never returned, only compared against 0 or 1.
   *
   * The deferred count covers crm/leads/deals/contacts/inventory, which are out of
   * this release's scope; it is printed so it cannot hide, not enforced.
   */
  if (countProbesInScope.length > 0) {
    console.error(
      `\n${countProbesInScope.length} count() aggregate(s) answer a yes/no question with no LIMIT. Rewrite as \`select({ one: sql\`1\` }).from(t).where(...).limit(1)\` and test rows.length — the numeric value is never used for anything but the comparison, so no response DTO changes:`,
    );
    for (const c of countProbesInScope) console.error(`  UNBOUNDED-COUNT-PROBE  ${c}`);
    failed = true;
  }

  /**
   * The existence half of this box's own clause, which nothing enforced until
   * this rule existed. The line above used to read "COUNT/EXISTENCE" while the
   * rule below it fired only on `.length` — so a read hydrating 34 columns of
   * `sign_recipients`, `otp_code_hash` and `signing_token_hash` among them, to
   * decide whether a recipient exists, passed a gate that claimed to cover it.
   *
   * Enforced at zero because an existence check has no response DTO: the value
   * is never returned, read or passed, which is what makes it a finding. There
   * is no product decision here and never was.
   */
  const existenceAllowed = baseline.existencePathsAllowed ?? 0;
  if (existenceInScope.length > existenceAllowed) {
    console.error(
      `\n${existenceInScope.length} read(s) hydrate a whole row to answer a yes/no question, against an allowance of ${existenceAllowed}. Narrowing one changes no response DTO — the result is only ever tested for null, truthiness or length. Add a \`columns:\` naming what the guard reads:`,
    );
    for (const e of existenceInScope) console.error(`  UNPROJECTED-EXISTENCE  ${e}`);
    failed = true;
  }

  const deferredAllowed = baseline.existenceDeferredAllowed ?? 0;
  if (existenceDeferred.length > deferredAllowed) {
    console.error(
      `\nRATCHET BREACH: existence paths in modules excluded from this release rose ${deferredAllowed} -> ${existenceDeferred.length}. They are not fixed here because crm/leads/deals/contacts/inventory are out of release scope, but they may not grow while that exclusion stands:`,
    );
    for (const e of existenceDeferred) console.error(`  DEFERRED-EXISTENCE  ${e}`);
    failed = true;
  }

  if (countPaths.length > baseline.countPathsAllowed) {
    console.error(
      `\n${countPaths.length} unprojected count/existence path(s) against an allowance of ${baseline.countPathsAllowed}. A count has no response DTO, so narrowing it changes no contract and needs no product decision — this is the clause ticket 20 CLOSED, and closing it is what stopped survey_participants.accessTokenHash being hydrated to answer a .length:`,
    );
    for (const c of countPaths) console.error(`  UNPROJECTED-COUNT  ${c}`);
    failed = true;
  }

  /**
   * Enforced on the TOTAL, reported per shape.
   *
   * Three independent ceilings are unusable in a shared tree. Measured here: one
   * lane projected chat/chat-channel-list.service.ts (findMany 295 -> 294) while
   * another added a bare `.select()` in a new file
   * (chat/chat-channel-member-preview.ts, 599 -> 600). Per-shape ceilings call
   * that a BREACH; the total is 1,441 either way, and it is 1,441 because
   * nothing got worse. A per-shape gate would have been raised by the next
   * person to hit it, which is how a ratchet becomes a rubber stamp.
   *
   * Trading a narrowed findMany for a new bare `.select()` is a real trade and
   * the total is the honest scoreboard for it. The per-shape numbers stay on the
   * output line so the composition is never hidden.
   */
  /**
   * The vector clause, at zero. An embedding or a generated tsvector on a read
   * path is invisible cost and, for `kb_pages`, a documented contract breach:
   * the module's own return type is Omit<..., "fts">.
   */
  const heavyAllowed = baseline.heavyColumnReadsAllowed ?? 0;
  if (heavyReads.length > heavyAllowed) {
    console.error(
      `\n${heavyReads.length} full-row read(s) of a table carrying a vector, tsvector or bytea column, against an allowance of ${heavyAllowed}. Name the columns, or exclude the heavy one (kb uses KB_PAGE_COLUMNS / KB_ARTICLE_COLUMNS for exactly this):`,
    );
    for (const h of heavyReads) console.error(`  HEAVY-COLUMN-READ  ${h}`);
    failed = true;
  }

  const total = totals.findMany + totals.findFirst + totals.bareSelect;
  const ceiling = baseline.findMany + baseline.findFirst + baseline.bareSelect;
  if (total > ceiling) {
    console.error(
      `\nRATCHET BREACH: unprojected reads rose ${ceiling} -> ${total} (findMany ${baseline.findMany}->${totals.findMany}, findFirst ${baseline.findFirst}->${totals.findFirst}, bare .select() ${baseline.bareSelect}->${totals.bareSelect}). This clause is BLOCKED on a product decision about which list endpoints may return less, so it is not required to fall — but it may not climb while that decision is outstanding.`,
    );
    failed = true;
  }

  if (!failed)
    console.log("\nNo unprojected count/existence path, and no population ceiling breached.");

  process.exitCode = failed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) main();
