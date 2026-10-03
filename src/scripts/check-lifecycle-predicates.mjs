#!/usr/bin/env node
/**
 * Gate: an active read of a soft-delete / archive table must carry its lifecycle
 * predicate.
 *
 * Nothing gated this class before. Ticket 06 found and fixed eleven genuine
 * defects — including a tax-payment void that posted a SECOND reversal journal
 * entry into the ledger because the load omitted `archived_at IS NULL`, and an
 * `hr_people ⨝ organization_people` join with no `deleted_at` predicate that kept
 * a deleted person's name and work email in the HR list — and not one of the ~150
 * existing gates saw any of them.
 *
 * THE HARD PART IS THE FALSE-POSITIVE RATE, NOT THE DETECTION.
 * A naive statement scanner flags 911 reads, because predicates are routinely
 * built in a `const conditions = […]` array or a private `treeFilter()` helper
 * that the statement text does not contain. So a candidate must survive all
 * three of ticket 06's filters:
 *
 *   1. statement-level — the read's own expression names neither the table's
 *      lifecycle column nor its status/isActive column;
 *   2. file-level      — the file never names `<sym>.<lifecycleProp>` anywhere,
 *      which rescues the conditions-array and helper-function shapes;
 *   3. writer census   — the lifecycle column is actually written by some code
 *      path. 12 of the 94 columns are declared and never set; a missing predicate
 *      on those is a dormant trap, reported separately, not counted as a defect.
 *
 * That intersection took 911 → 30 candidates at a 37% true-positive rate.
 *
 * A SECOND PASS COVERS WHAT THE STATEMENT SCANNER IS STRUCTURALLY BLIND TO:
 * four of ticket 06's defects live in join `ON` conditions on an aliased
 * self-join, not in a `WHERE`. A gate that only inspects statements inherits that
 * blindness, so join sites are resolved and reported in their own category.
 *
 * ACCEPTED carries every candidate ticket 06 read and ruled correct-as-written,
 * each with its reason. A stale entry — one that is no longer a candidate — fails
 * the gate, so the list cannot rot into a silent permanent exemption.
 *
 * Flags:
 *   --self-test   Fixture-driven assertions, no repository scan.
 *   --list        Print every candidate with its classification and exit 0.
 *
 * Exit codes:
 *   0 candidates within the accepted set · 1 a new candidate (or self-test failed)
 *   2 the scan is vacuous — it measured nothing, so a clean result proves nothing
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const LIST = process.argv.includes("--list");

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = join(SCRIPT_DIR, "../..");
const SRC = join(BACKEND_ROOT, "src");
const SCHEMA_DIR = join(SRC, "db", "schema");

/** Excluded from the release, per ticket 06's own scope. */
const EXCLUDED_SCHEMA_DIRS = ["/db/schema/crm/"];

/**
 * Global identity and tenant-root tables. BE/CLAUDE.md §4 puts `users`,
 * `accounts` and `sessions` outside ordinary tenant lifecycle rules — a
 * deactivated user must still resolve for authentication, audit attribution and
 * historical display, and an organization row must still resolve for the very
 * request that is closing it. Reads of these are a different question with a
 * different answer, so they are named here rather than drowning the signal:
 * before this exclusion they were 175 of 250 primary-read candidates.
 */
const GLOBAL_IDENTITY_TABLES = new Map([
  ["users", "global identity — a deactivated user must still resolve for auth, audit attribution and display (BE/CLAUDE.md §4)"],
  ["organizations", "tenant root — must resolve during its own closure and for platform administration"],
  ["accounts", "global identity — authentication provider linkage"],
  ["sessions", "global identity — revocation reads must see revoked rows"],
]);

const LIFECYCLE_COLUMNS = [
  "deleted_at",
  "archived_at",
  "is_deleted",
  "is_archived",
  "purged_at",
  "removed_at",
];

const MIN_TABLES = 500;
const MIN_LIFECYCLE_TABLES = 50;
const MIN_READ_SITES = 500;

/**
 * Join reads onto a lifecycle table with no predicate. Mostly display joins that
 * must render a historical name, so this is a ratchet, not a target: it may only
 * go down. It exists so the join class — which no statement scanner can see —
 * cannot grow silently.
 */
/*
 * LOWERED 230 -> 85 on 2026-09-12, in the same change that stopped this arm
 * counting `users` and `organizations` (see the `joinCandidates` filter). The
 * population fell 279 -> 85 because 194 of those joins were onto tables this file
 * already declares outside the rule. 230 over a population of 85 would have been a
 * ratchet that could never fire, so it is re-recorded at the measurement.
 *
 * Then 85 -> 83 in the same pass: the product export and the opening-stock import
 * each gained an `is null` predicate on the product/variant join they had been
 * missing, which is the ratchet doing what it is for.
 */
/*
 * 83 -> 79 on 2026-09-29, arithmetic only: the arm now counts unadjudicated joins
 * (see the note above `openCandidates`), and 4 of the 83 are sites ACCEPTED rules
 * on. Subtracting them is a lowering; no join was re-measured to arrive at it.
 */
const JOIN_CANDIDATE_BASELINE = 79;

/**
 * Primary reads (`from` / `db.query`) of a lifecycle table with no predicate,
 * after all three of ticket 06's filters and the global-identity exclusion.
 * A ratchet on a previously ungated class, not a clean bill: ticket 06 hand-
 * audited 27 of these and found 11 genuine. It may only go down.
 */
/*
 * 68 -> 57 on 2026-09-29, same arithmetic: 11 of the 68 are ACCEPTED sites, and the
 * arm counts the unadjudicated remainder. `readBulkTicketMeta` in
 * build-ticket-bulk-effects.ts took the raw count 69 -> 68 in the same change.
 */
const PRIMARY_CANDIDATE_BASELINE = 57;

/**
 * Read sites ticket 06 opened individually and ruled correct as written, plus the
 * ones it left open with a stated reason. Each entry is `file::symbol` and must
 * still be a candidate — a stale entry fails.
 */
const ACCEPTED = [
  { site: "modules/surveys/survey-automation.service.ts::surveyForms", reason: "an archived survey must stay inspectable to be restored (report 06)" },
  { site: "modules/surveys/survey-response-submitted-consumer.service.ts::surveyForms", reason: "a response to an archived survey must still be consumed (report 06)" },
  { site: "modules/ai/core/services/survey-ai.service.ts::surveyForms", reason: "reported by ticket 06, outside its territory" },
  { site: "modules/kb/core/kb-subject-erasure.ts::kbSources", reason: "erasure deliberately sweeps deleted rows (report 06); moved out of modules/gdpr by 1d7062fec" },
  { site: "modules/kb/core/kb-subject-erasure.ts::kbPages", reason: "erasure deliberately sweeps deleted rows (report 06); moved out of modules/gdpr by 1d7062fec" },
  { site: "modules/build/client-portal/change-request-number-counter.ts::changeRequests", reason: "number allocator: MAX(cr_number) must see soft-deleted rows or a restored CR collides with a reissued number (Build lifecycle sweep, 02-schemas box 2)" },
  { site: "modules/build/qa/test-runs.service.ts::tickets", reason: "number allocator: MAX(ticket_number) must see soft-deleted rows or a retired ticket number is reused (Build lifecycle sweep)" },
  { site: "modules/build/core/project-crud/projects-templates.service.ts::tickets", reason: "number allocator on a project created in the same transaction, so the count is always zero; filtering would still be wrong in principle (Build lifecycle sweep)" },
  { site: "modules/build/core/activity/projects-activity.service.ts::tickets", reason: "resolves a ticket's project to WRITE its activity row; filtering would drop the audit trail of the deletion itself (Build lifecycle sweep)" },
  { site: "modules/build/core/activity/projects-activity.service.ts::organizationPeople", reason: "display-name resolution: filtering blanks the name on every record a departed colleague touched, which is this gate's own stated reason for excluding identity tables (Build lifecycle sweep)" },
  { site: "modules/build/core/tickets/projects-ticket-comments.service.ts::organizationPeople", reason: "comment-author display join, same class as the activity one above (Build lifecycle sweep)" },
  { site: "modules/build/core/budget/projects-budget.service.ts::tickets", reason: "cost aggregate: money already spent does not un-spend when a ticket is retired, and filtering would understate actuals against Accounting (Build lifecycle sweep)" },
  { site: "modules/build/execution/timesheets.service.ts::projects", reason: "effort aggregate, same reasoning as the budget rollup: excluding retired projects makes the per-project hours stop summing to the org total (Build lifecycle sweep)" },
  { site: "modules/build/comment-drafts/comment-drafts.service.ts::projects", reason: "display leftJoin supplying projectKey/projectName; filtering blanks the label instead of removing the row. If a draft on a retired project should vanish, the predicate belongs in the where clause (Build lifecycle sweep)" },
  { site: "modules/build/core/tickets/projects-tickets-read.query.ts::tickets", reason: "shared helper whose `where` is supplied by the caller; it cannot carry a predicate without breaking its contract, and every caller passes isNull(deletedAt). Structurally invisible to this gate (Build lifecycle sweep)" },
  { site: "modules/build/core/project-crud/projects-restore.service.ts::projectTemplates", reason: "restore path: the row it reads is by definition the soft-deleted one, and filtering deleted_at would make every restore 404 (Build lifecycle completeness, lane H1)" },
  { site: "modules/build/core/tickets/projects-tickets-restore.service.ts::projects", reason: "restore path: reads the parent project WITH its deleted_at so a child restore can refuse and name a still-deleted parent per BE-54 (Build lifecycle completeness, lane H1)" },
  { site: "modules/payroll/sample-data/sample-data.service.ts::organizationPeople", reason: "payroll sample-data status gates the hard-delete remove path: an archived or soft-deleted sample person must still count as present, or remove short-circuits and leaves the sample rows behind forever (HRMS+Payroll wave 1)" },
];

function snakeToCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walkTs(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".e2e-spec.ts") &&
      !entry.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Parse Drizzle table declarations. The `(?:pgTable|\w+\.table)\(` form is
 * required: the Build module declares `pgSchema("build")` and uses
 * `build.table(...)`, and a `pgTable(`-only pattern silently omits all 83 of them.
 */
export function parseTables(source) {
  const tables = [];
  const re = /export const ([A-Za-z0-9_]+)\s*=\s*(?:pgTable|[A-Za-z0-9_]+\.table)\(\s*\n?\s*["']([a-z0-9_]+)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const nextIdx = source.indexOf("\nexport const", m.index + 10);
    const body = source.slice(m.index, nextIdx < 0 ? source.length : nextIdx);
    const lifecycle = LIFECYCLE_COLUMNS.filter((c) => body.includes(`"${c}"`) || body.includes(`'${c}'`));
    tables.push({ symbol: m[1], table: m[2], lifecycle, body });
  }
  return tables;
}

/** Property names on the Drizzle object for a table's lifecycle columns. */
export function lifecycleProps(entry) {
  const props = new Set();
  for (const col of entry.lifecycle) {
    props.add(snakeToCamel(col));
    const declared = new RegExp(`([A-Za-z0-9_]+)\\s*:\\s*[A-Za-z0-9_]+\\(\\s*["']${col}["']`).exec(entry.body);
    if (declared) props.add(declared[1]);
  }
  return [...props];
}

/** The statement text around a read site: to the enclosing `;` or blank line. */
export function statementAround(source, index) {
  let start = index;
  for (let i = index; i >= 0 && index - i < 4000; i--) {
    if (source[i] === ";" || (source[i] === "\n" && source[i - 1] === "\n")) {
      start = i + 1;
      break;
    }
    start = i;
  }
  let end = source.length;
  for (let i = index; i < source.length && i - index < 4000; i++) {
    if (source[i] === ";") {
      end = i;
      break;
    }
  }
  return source.slice(start, end);
}

const READ_FORMS = [
  { kind: "from", re: (sym) => new RegExp(`\\.from\\s*\\(\\s*${sym}\\b`, "g") },
  { kind: "join", re: (sym) => new RegExp(`\\.(?:left|inner|right|full)Join\\s*\\(\\s*${sym}\\b`, "g") },
  { kind: "query", re: (sym) => new RegExp(`\\bdb\\.query\\.${sym}\\.(?:findMany|findFirst)\\b`, "g") },
];

export function mentionsLifecycle(text, symbol, props) {
  for (const p of props) if (text.includes(`${symbol}.${p}`)) return true;
  // A status / isActive predicate on the same table is an accepted alternative.
  if (new RegExp(`\\b${symbol}\\.(status|isActive|isArchived|isDeleted|state)\\b`).test(text)) return true;
  return false;
}

/**
 * Is the lifecycle column ever actually written FOR THIS TABLE? Scoped to the
 * table, not the repository: `deletedAt:` appears in hundreds of files, so an
 * unscoped test reports every column as live and the dormant class disappears.
 */
export function isColumnWritten(allSources, symbol, props) {
  const writeRe = new RegExp(`\\.(?:update|insert)\\s*\\(\\s*${symbol}\\s*\\)`, "g");
  for (const src of allSources) {
    if (!src.includes(symbol)) continue;
    writeRe.lastIndex = 0;
    let m;
    while ((m = writeRe.exec(src)) !== null) {
      const window = src.slice(m.index, m.index + 1200);
      for (const p of props) if (new RegExp(`\\b${p}\\s*:`).test(window)) return true;
    }
  }
  return false;
}

/**
 * A helper takes the table as a defaulted parameter (`employments = hrEmployments`)
 * and then predicates through the alias, so the strict `symbol.prop` test never
 * matches inside its body. Only ever applied to a body already proven to name the
 * table symbol, so the alias cannot belong to a different table.
 */
function aliasedLifecyclePredicate(body, props) {
  for (const p of props)
    if (new RegExp(`isNull\\s*\\(\\s*\\w+\\.${p}\\b`).test(body)) return true;
  return false;
}

/**
 * Exported helpers that build the lifecycle predicate for a table, keyed by the
 * table symbol they cover. `liveEmployment(orgId)` is `isNull(hrEmployments.deletedAt)`
 * behind a name, so a read that calls it IS predicated — but the predicate lives in
 * another file, which the in-file rescue cannot see. Without this the scanner reports
 * correct code, and the only way to keep the gate green is to raise its baseline.
 */
export function collectLifecycleHelpers(allSources, bySymbol) {
  const byHelper = new Map();
  const defRe = /export\s+function\s+(\w+)\s*\(/g;
  for (const src of allSources) {
    defRe.lastIndex = 0;
    let m;
    while ((m = defRe.exec(src)) !== null) {
      const name = m[1];
      const next = src.indexOf("\nexport ", m.index + 1);
      const body = src.slice(m.index, next === -1 ? src.length : next);
      for (const [symbol, entry] of bySymbol) {
        if (!body.includes(symbol)) continue;
        if (!mentionsLifecycle(body, symbol, entry.props) && !aliasedLifecyclePredicate(body, entry.props))
          continue;
        if (!byHelper.has(name)) byHelper.set(name, new Set());
        byHelper.get(name).add(symbol);
      }
    }
  }
  return byHelper;
}

export function statementCallsLifecycleHelper(statement, symbol, helpers) {
  if (!helpers) return false;
  for (const [name, symbols] of helpers) {
    if (!symbols.has(symbol)) continue;
    if (new RegExp(`\\b${name}\\s*\\(`).test(statement)) return true;
  }
  return false;
}

export function classifyReadSite({ statement, fileSource, symbol, props, columnWritten, helpers }) {
  const inStatement = mentionsLifecycle(statement, symbol, props);
  const inFile = mentionsLifecycle(fileSource, symbol, props);
  if (inStatement) return { verdict: "OK", why: "predicate is in the read's own expression" };
  if (inFile) return { verdict: "OK-FILE", why: "predicate is built elsewhere in the file (conditions array or helper)" };
  if (statementCallsLifecycleHelper(statement, symbol, helpers))
    return { verdict: "OK-HELPER", why: "the read calls an exported helper that builds the lifecycle predicate for this table" };
  if (!columnWritten) return { verdict: "DORMANT", why: "the lifecycle column is never written by any code path" };
  return { verdict: "CANDIDATE", why: "neither the statement nor the file names the lifecycle column, and the column is live" };
}

function scan() {
  const schemaFiles = walkTs(SCHEMA_DIR);
  const tables = [];
  for (const f of schemaFiles) {
    const rel = relative(BACKEND_ROOT, f).replace(/\\/g, "/");
    if (EXCLUDED_SCHEMA_DIRS.some((d) => `/${rel}`.includes(d))) continue;
    for (const t of parseTables(readFileSync(f, "utf8"))) tables.push(t);
  }

  const lifecycleTables = tables.filter((t) => t.lifecycle.length > 0);
  const bySymbol = new Map(lifecycleTables.map((t) => [t.symbol, { ...t, props: lifecycleProps(t) }]));

  const readFiles = walkTs(SRC).filter((f) => !f.includes(`${SCHEMA_DIR}`));
  const sources = new Map();
  for (const f of readFiles) {
    try {
      sources.set(f, readFileSync(f, "utf8"));
    } catch {
      /* unreadable file is not a finding */
    }
  }
  const allSources = [...sources.values()];

  const writtenCache = new Map();
  const columnWritten = (symbol, props) => {
    if (!writtenCache.has(symbol)) writtenCache.set(symbol, isColumnWritten(allSources, symbol, props));
    return writtenCache.get(symbol);
  };

  const helpers = collectLifecycleHelpers(allSources, bySymbol);

  const sites = [];
  for (const [file, source] of sources) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    for (const [symbol, entry] of bySymbol) {
      if (!source.includes(symbol)) continue;
      for (const form of READ_FORMS) {
        const re = form.re(symbol);
        let m;
        while ((m = re.exec(source)) !== null) {
          const statement = statementAround(source, m.index);
          const verdict = classifyReadSite({
            statement,
            fileSource: source,
            symbol,
            props: entry.props,
            columnWritten: columnWritten(symbol, entry.props),
            helpers,
          });
          sites.push({
            file: rel,
            line: source.slice(0, m.index).split("\n").length,
            symbol,
            table: entry.table,
            kind: form.kind,
            ...verdict,
          });
        }
      }
    }
  }

  return { tables, lifecycleTables, sites, fileCount: readFiles.length };
}

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  // --- table parsing: the pgTable-only trap ---
  const schemaFixture = `
export const goals = pgTable("goals", {
  id: uuid("id").primaryKey(),
  orgId: text("org_id").notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const tickets = build.table("tickets", {
  id: uuid("id").primaryKey(),
  archivedAt: timestamp("archived_at"),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey(),
  action: text("action"),
});
`;
  const parsed = parseTables(schemaFixture);
  assert("parses a pgTable declaration", parsed.some((t) => t.symbol === "goals"));
  assert(
    "parses a build.table declaration — a pgTable-only pattern omits all 83 of them",
    parsed.some((t) => t.symbol === "tickets"),
  );
  assert("detects deleted_at as a lifecycle column", parsed.find((t) => t.symbol === "goals")?.lifecycle.includes("deleted_at") === true);
  assert("detects archived_at as a lifecycle column", parsed.find((t) => t.symbol === "tickets")?.lifecycle.includes("archived_at") === true);
  assert("a table with no lifecycle column is not one", parsed.find((t) => t.symbol === "auditLogs")?.lifecycle.length === 0);
  assert(
    "the declared property name is resolved, not guessed",
    lifecycleProps(parsed.find((t) => t.symbol === "goals")).includes("deletedAt"),
  );

  // --- classification: the three filters ---
  const missing = `
    async list(orgId: string) {
      return this.db.select().from(goals).where(eq(goals.orgId, orgId));
    }
  `;
  const inStatement = `
    async list(orgId: string) {
      return this.db.select().from(goals).where(and(eq(goals.orgId, orgId), isNull(goals.deletedAt)));
    }
  `;
  const inConditionsArray = `
    async list(orgId: string) {
      const conditions = [eq(goals.orgId, orgId), isNull(goals.deletedAt)];
      return this.db.select().from(goals).where(and(...conditions));
    }
  `;
  const statusPredicate = `
    async list(orgId: string) {
      return this.db.select().from(goals).where(and(eq(goals.orgId, orgId), eq(goals.status, "ACTIVE")));
    }
  `;
  const cls = (src, written = true) =>
    classifyReadSite({
      statement: statementAround(src, src.indexOf(".from(goals)")),
      fileSource: src,
      symbol: "goals",
      props: ["deletedAt"],
      columnWritten: written,
    }).verdict;

  assert("a read with no lifecycle predicate anywhere is a CANDIDATE", cls(missing) === "CANDIDATE");
  assert("a predicate in the statement is OK", cls(inStatement) === "OK");
  assert(
    "a predicate built in a conditions array is OK — this is the filter that cuts 911 flags to 30",
    cls(inConditionsArray) === "OK-FILE",
  );
  assert("a status predicate on the same table is accepted", cls(statusPredicate) === "OK");
  assert(
    "a missing predicate on a never-written column is DORMANT, not a defect",
    cls(missing, false) === "DORMANT",
  );

  // --- the join class the statement scanner is structurally blind to ---
  const joinMiss = `
    async listPeople(orgId: string) {
      return this.db
        .select()
        .from(hrPeople)
        .innerJoin(organizationPeople, eq(hrPeople.personId, organizationPeople.id))
        .where(eq(hrPeople.orgId, orgId));
    }
  `;
  const joinSites = [];
  const joinRe = READ_FORMS[1].re("organizationPeople");
  let jm;
  while ((jm = joinRe.exec(joinMiss)) !== null) joinSites.push(jm.index);
  assert("a join read site is located at all", joinSites.length === 1);
  assert(
    "an ON-clause join with no lifecycle predicate is a CANDIDATE — the hr_people join defect",
    classifyReadSite({
      statement: statementAround(joinMiss, joinSites[0]),
      fileSource: joinMiss,
      symbol: "organizationPeople",
      props: ["deletedAt"],
      columnWritten: true,
    }).verdict === "CANDIDATE",
  );
  const joinFixed = joinMiss.replace(
    "eq(hrPeople.personId, organizationPeople.id)",
    "and(eq(hrPeople.personId, organizationPeople.id), isNull(organizationPeople.deletedAt))",
  );
  const fixedIdx = READ_FORMS[1].re("organizationPeople").exec(joinFixed).index;
  assert(
    "the shipped fix for the join defect produces no candidate",
    classifyReadSite({
      statement: statementAround(joinFixed, fixedIdx),
      fileSource: joinFixed,
      symbol: "organizationPeople",
      props: ["deletedAt"],
      columnWritten: true,
    }).verdict !== "CANDIDATE",
  );

  // --- writer census ---
  assert(
    "a column set on an update path counts as written",
    isColumnWritten(["await tx.update(goals).set({ deletedAt: new Date() });"], "goals", ["deletedAt"]) === true,
  );
  assert(
    "a column only ever declared is NOT written",
    isColumnWritten(["const x = goals.deletedAt;"], "goals", ["deletedAt"]) === false,
  );

  // --- the real repository, so a parser change that empties the scan fails here ---
  const real = scan();
  assert(
    `the real schema parses at least ${MIN_TABLES} tables (found ${real.tables.length})`,
    real.tables.length >= MIN_TABLES,
  );
  assert(
    `at least ${MIN_LIFECYCLE_TABLES} of them carry a lifecycle column (found ${real.lifecycleTables.length})`,
    real.lifecycleTables.length >= MIN_LIFECYCLE_TABLES,
  );
  assert(
    `at least ${MIN_READ_SITES} read sites are located (found ${real.sites.length})`,
    real.sites.length >= MIN_READ_SITES,
  );
  const acceptedInSelfTest = new Set(ACCEPTED.map((a) => a.site));
  const primaryCandidates = real.sites.filter(
    (s) =>
      s.verdict === "CANDIDATE" &&
      s.kind !== "join" &&
      !GLOBAL_IDENTITY_TABLES.has(s.table) &&
      !acceptedInSelfTest.has(`${s.file}::${s.symbol}`),
  ).length;
  assert(
    `the three-way filter keeps the primary-read candidate set actionable — a gate that flags hundreds gets switched off (found ${primaryCandidates})`,
    primaryCandidates <= PRIMARY_CANDIDATE_BASELINE,
  );
  assert(
    "the filters actually remove noise — the unfiltered statement scan is far larger",
    real.sites.filter((s) => s.verdict === "CANDIDATE").length > primaryCandidates * 2,
  );
  assert(
    "the writer census is table-scoped, so dormant columns are still found",
    real.sites.filter((s) => s.verdict === "DORMANT").length > 0,
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-lifecycle-predicates self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-lifecycle-predicates self-tests: ${passed} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

const { tables, lifecycleTables, sites, fileCount } = scan();

// A primary-table read is the strong-candidate class ticket 06's three-way
// filter produced. A display join (`.leftJoin(users, …)` to render a name) is a
// different question with a different answer, and lumping the two together is
// how a scanner ends up crying wolf 900 times and getting switched off.
const candidates = sites.filter(
  (s) => s.verdict === "CANDIDATE" && s.kind !== "join" && !GLOBAL_IDENTITY_TABLES.has(s.table),
);
const globalIdentityCandidates = sites.filter(
  (s) => s.verdict === "CANDIDATE" && s.kind !== "join" && GLOBAL_IDENTITY_TABLES.has(s.table),
);
/*
 * ⚠ CORRECTED 2026-09-12. `GLOBAL_IDENTITY_TABLES` was applied to the primary-read
 * arm (twice, at the vacuity guard and at `candidates`) and forgotten here, so the
 * join arm counted the very tables this file declares outside the rule. It was not
 * a small leak: 188 of 279 join candidates were joins onto `users` and 6 more onto
 * `organizations` — 194 of 279.
 *
 * The exclusion applies with MORE force to a join than to a primary read, and both
 * comments above already say so. `users` is excluded because "a deactivated user
 * must still resolve for auth, audit attribution and historical display", and
 * JOIN_CANDIDATE_BASELINE's own docblock describes this class as "mostly display
 * joins that must render a historical name". Those are the same sentence about the
 * same rows. A `leftJoin(users, ...)` fetching an author's name is the case the
 * exclusion was written for; adding `deleted_at is null` to it would blank the name
 * on every historical record a departed user touched.
 *
 * The baseline is lowered to the post-exclusion measurement in the same change —
 * leaving it at 230 over a population of ~85 would have retired the ratchet.
 */
const joinCandidates = sites.filter(
  (s) => s.verdict === "CANDIDATE" && s.kind === "join" && !GLOBAL_IDENTITY_TABLES.has(s.table),
);
const globalIdentityJoins = sites.filter(
  (s) => s.verdict === "CANDIDATE" && s.kind === "join" && GLOBAL_IDENTITY_TABLES.has(s.table),
);
const dormant = sites.filter((s) => s.verdict === "DORMANT");

/*
 * The two ratchets below count UNADJUDICATED candidates, not every candidate.
 * They used to count every one, including the sites ACCEPTED already rules on with
 * a stated reason, and that scoping is a defect: an entry added to ACCEPTED left
 * the count where it was, so the only way to hold a repair was to move the number,
 * and a site dropping out of the scan for the wrong reason — a renamed file, a
 * parser regression, a read deleted rather than fixed — made the gate greener with
 * no repair behind it. Identity does the scoping now: ACCEPTED removes a named site
 * from the count and a stale entry still fails, so the frozen set cannot grow
 * without a reason written next to it.
 *
 * Both baselines are lowered to the post-exclusion equivalent of the numbers they
 * replace (68 counted 11 accepted primary sites; 83 counted 4 accepted joins).
 * Neither is raised: the arithmetic is subtraction, not a re-measurement.
 */
const acceptedSites = new Set(ACCEPTED.map((a) => a.site));
const isAccepted = (s) => acceptedSites.has(`${s.file}::${s.symbol}`);
const openCandidates = candidates.filter((s) => !isAccepted(s));
const openJoinCandidates = joinCandidates.filter((s) => !isAccepted(s));

/** Which module owns the open candidates, so a failure is attributable on sight. */
function byModule(list) {
  const tally = new Map();
  for (const s of list) {
    const key = s.file.split("/").slice(0, 2).join("/");
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");
}

console.log(
  `Tables ${tables.length}  ·  with a lifecycle column ${lifecycleTables.length}  ·  read sites ${sites.length} across ${fileCount} files`,
);
console.log(
  `  predicate in statement ${sites.filter((s) => s.verdict === "OK").length}  ·  built elsewhere in file ${sites.filter((s) => s.verdict === "OK-FILE").length}  ·  dormant column ${dormant.length}  ·  primary-read candidates ${candidates.length} (${openCandidates.length} unadjudicated)  ·  join candidates ${joinCandidates.length} (${openJoinCandidates.length} unadjudicated)`,
);

if (LIST) {
  console.log("\n-- primary-read candidates --");
  for (const s of candidates.sort((a, b) => a.file.localeCompare(b.file)))
    console.log(`  ${s.file}:${s.line}  ${s.symbol} (${s.kind})${isAccepted(s) ? "  [accepted]" : ""}`);
  console.log("\n-- join candidates (the class a statement scanner is blind to) --");
  for (const s of joinCandidates.sort((a, b) => a.file.localeCompare(b.file)))
    console.log(`  ${s.file}:${s.line}  ${s.symbol}${isAccepted(s) ? "  [accepted]" : ""}`);
  process.exit(0);
}

if (
  tables.length < MIN_TABLES ||
  lifecycleTables.length < MIN_LIFECYCLE_TABLES ||
  sites.length < MIN_READ_SITES
) {
  console.error(
    `INCONCLUSIVE — parsed ${tables.length} tables (floor ${MIN_TABLES}), ${lifecycleTables.length} with a lifecycle column (floor ${MIN_LIFECYCLE_TABLES}), ${sites.length} read sites (floor ${MIN_READ_SITES}). The scan is broken; "no candidates" would prove nothing.`,
  );
  process.exit(2);
}

const seen = new Set();
for (const c of [...candidates, ...joinCandidates]) {
  const key = `${c.file}::${c.symbol}`;
  if (acceptedSites.has(key)) seen.add(key);
}
const stale = ACCEPTED.filter((a) => !seen.has(a.site));

if (dormant.length > 0)
  console.log(
    `\nNOTE — ${dormant.length} read(s) omit a predicate on a lifecycle column no code path ever writes. A dormant trap, not a live defect.`,
  );
if (globalIdentityCandidates.length > 0)
  console.log(
    `NOTE — ${globalIdentityCandidates.length} read(s) of a global identity or tenant-root table are outside this rule by design: ${[...GLOBAL_IDENTITY_TABLES.keys()].join(", ")}.`,
  );
// Printed rather than silently dropped: this is the larger half of the exclusion
// and it must stay visible, not become an invisible exemption.
if (globalIdentityJoins.length > 0)
  console.log(
    `NOTE — ${globalIdentityJoins.length} JOIN(s) onto those same tables, excluded for the same reason. A display join that rendered only non-deleted users would blank the name on every record a departed colleague touched.`,
  );

let failed = false;

if (stale.length > 0) {
  console.error(`\nFAIL — ${stale.length} stale ACCEPTED entry(ies); the read is no longer a candidate. Remove them:`);
  for (const a of stale) console.error(`  ${a.site}  (${a.reason})`);
  failed = true;
}

if (openCandidates.length > PRIMARY_CANDIDATE_BASELINE) {
  console.error(
    `\nFAIL — ${openCandidates.length} unadjudicated primary reads of a lifecycle table carry no predicate, ${openCandidates.length - PRIMARY_CANDIDATE_BASELINE} above the recorded baseline of ${PRIMARY_CANDIDATE_BASELINE}. Owners: ${byModule(openCandidates)}. Run with --list.`,
  );
  failed = true;
}

if (openJoinCandidates.length > JOIN_CANDIDATE_BASELINE) {
  console.error(
    `\nFAIL — ${openJoinCandidates.length} unadjudicated joins onto a lifecycle table carry no predicate, ${openJoinCandidates.length - JOIN_CANDIDATE_BASELINE} above the recorded baseline of ${JOIN_CANDIDATE_BASELINE}. Owners: ${byModule(openJoinCandidates)}. Four of ticket 06's eleven defects were exactly this shape — an ON condition on an aliased self-join, which no statement scanner can see. Run with --list.`,
  );
  failed = true;
}

if (failed) process.exit(1);

console.log(
  `\nOK — unadjudicated primary-read candidates ${openCandidates.length} (baseline ${PRIMARY_CANDIDATE_BASELINE}) · unadjudicated join candidates ${openJoinCandidates.length} (baseline ${JOIN_CANDIDATE_BASELINE}).`,
);
console.log(
  "Both numbers are ratchets recording the measured state when this gate was written, not a clean bill of health. They may only go down; a new occurrence of either shape fails immediately.",
);
