/**
 * A record fetched by id must not be able to be a deleted one.
 *
 * Only record reads count -- those refused with NotFound. A uniqueness conflict
 * check is a different question (it depends on whether the unique index is
 * partial), `users` and `organizations` are global identity tables section 4
 * exempts, and a purge read deliberately wants the deleted row.
 *
 * The tenant half is reported by --tenant, not gated: RLS adds that predicate in
 * the database, and public, portal and platform paths have no tenant in context.
 *
 * Usage:  node src/scripts/check-record-access.mjs [--tenant] [--self-test]
 * Exit:   0 clean · 1 a read can return a deleted row · 2 broken parser
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SCHEMA_DIR = join(BACKEND_ROOT, "src", "db", "schema");
const MODULES_DIR = join(BACKEND_ROOT, "src", "modules");

/**
 * The corpus is three trees, not one.
 *
 * `src/modules` alone until 2026-09-03, so a clean result was a statement about
 * src/modules that read as a statement about the system. src/common (the whole
 * asynchronous substrate) and src/db were structurally invisible.
 *
 * Measured on the day of the change: src/common holds 2 findFirst reads and src/db
 * holds 0, so this union does NOT surface a backlog — that is the honest report, and
 * the value is that a record read moved or added there is now inside the corpus
 * instead of outside it. Every path is reported relative to the backend root, so the
 * three trees cannot collide on a name.
 */
const SCAN_DIRS = [
  MODULES_DIR,
  join(BACKEND_ROOT, "src", "common"),
  join(BACKEND_ROOT, "src", "db"),
];

const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

// /** Global identity and catalog tables, exempt by backend/CLAUDE.md section 4
export const GLOBAL_TABLES = new Set([
  "users",
  "organizations",
  "accounts",
  "sessions",
  "verificationTokens",
]);

// /** Reads that want the deleted row, each with the reason
export const PURGE_READS = new Map([
  [
    "src/modules/kb/wiki/kb-page-trash.service.ts::kbPages",
    "hardDelete reads the page in order to purge it; excluding deleted rows would make a deleted page unpurgeable",
  ],
]);

// -- parsing -----------------------------------------------------------------

export function balanced(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

// /** table symbol -> { tenant, softDelete } for every pgTable in the schema
export function parseSchema(sources) {
  const tables = {};
  for (const src of sources) {
    for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*pgTable\(/g)) {
      const body = balanced(src, m.index + m[0].length - 1);
      if (!body) continue;
      tables[m[1]] = {
        tenant: /\w+:\s*text\(\s*["'](org_id|organization_id)["']/.test(body),
        softDelete: /deletedAt:/.test(body),
      };
    }
  }
  return tables;
}

/**
 * A soft-delete clause is not always spelled at the call site. The KB reads
 * compose theirs from a named helper — `supportArticlePredicate()` renders
 * `content_type = 'support_article' AND deleted_at IS NULL` — so the predicate
 * is really applied, but the word `deletedAt` never appears inside the findFirst
 * parens. Measured 2026-09-24: that reported four correctly-filtered KB reads as
 * unguarded, and the remedy the gate printed (`add isNull(kbPages.deletedAt)`)
 * was redundant on all four.
 *
 * The helpers are resolved rather than named, so this cannot rot into an
 * allowlist: a function counts only while its own body still applies
 * `isNull(<table>.deletedAt)`. A helper that stops filtering stops excusing its
 * callers on the same run, and they fail as they should.
 */
export function softDeletePredicateHelpers(sources) {
  const names = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/export\s+(?:function|const)\s+(\w+)/g)) {
      const brace = src.indexOf("{", m.index);
      if (brace === -1) continue;
      const body = balanced(src, brace);
      if (body && /isNull\(\s*\w+\.deletedAt\s*\)/.test(body)) names.add(m[1]);
    }
  }
  return names;
}

function callsSoftDeleteHelper(predicates, helpers) {
  for (const name of helpers)
    if (new RegExp(`\\b${name}\\s*\\(`).test(predicates)) return true;
  return false;
}

/**
 * ADR 0005: a ScopedRead spends its predicates in the runner spec, not in the
 * findFirst call — `read.read({ tenant, scope, and: [...] }, ({ sql: where }) =>
 * db.query.x.findFirst({ where }))`. The tenant and soft-delete clauses are then
 * outside the findFirst parens, so inspecting those parens alone reports a
 * correctly-filtered read as unguarded. Only widen when the call actually
 * consumes a runner-supplied `where`, so an ordinary read is still judged on its
 * own body.
 */
export function scopedReadSpecFor(src, index, body) {
  if (!/\bwhere\b/.test(body)) return "";
  const start = Math.max(0, index - 900);
  const preceding = src.slice(start, index);
  const opener = preceding.lastIndexOf(".read(");
  const composer = preceding.lastIndexOf(".compose(");
  const at = Math.max(opener, composer);
  if (at === -1) return "";
  return preceding.slice(at);
}

// Classify each findFirst by what the code does with the result
export function parseFindFirst(src, tables, softDeleteHelpers = new Set()) {
  const found = [];
  for (const m of src.matchAll(/\.query\.(\w+)\.findFirst\(/g)) {
    const table = tables[m[1]];
    if (!table) continue;
    const body = balanced(src, m.index + m[0].length - 1);
    if (!body) continue;
    // Stop at the end of the enclosing method
    const window = src.slice(m.index + body.length, m.index + body.length + 400);
    const boundary = window.search(/\n {0,4}\}\n|\n\s*(?:public |private |async )/);
    const after = boundary === -1 ? window : window.slice(0, boundary);
    const shape = /if\s*\(\s*!\s*[\w.]+\s*\)[\s\S]{0,90}NotFound/.test(after)
      ? "read"
      : /if\s*\(\s*[\w.]+\s*\)[\s\S]{0,90}Conflict/.test(after)
        ? "conflict"
        : "other";
    const predicates = body + scopedReadSpecFor(src, m.index, body);
    found.push({
      table: m[1],
      line: src.slice(0, m.index).split("\n").length,
      shape,
      hasTenant: /\.orgId|\.organizationId/.test(predicates),
      hasSoftDelete:
        /deletedAt/.test(predicates) ||
        callsSoftDeleteHelper(predicates, softDeleteHelpers),
    });
  }
  return found;
}

// -- self-test ---------------------------------------------------------------

if (args.includes("--self-test")) {
  const schema = parseSchema([
    `export const kbSpaces = pgTable("kb_spaces", {
       id: serial("id").primaryKey(),
       orgId: text("org_id").notNull(),
       deletedAt: timestamp("deleted_at"),
     });
     export const users = pgTable("users", {
       id: text("id").primaryKey(),
       deletedAt: timestamp("deleted_at"),
     });
     export const auditLogs = pgTable("audit_logs", {
       id: serial("id").primaryKey(),
       orgId: text("org_id").notNull(),
     });`,
  ]);

  const source = [
    `  async a(orgId: string, spaceId: number) {`,
    `    const space = await this.db.query.kbSpaces.findFirst({`,
    `      where: and(eq(kbSpaces.id, spaceId), eq(kbSpaces.orgId, orgId)),`,
    `    });`,
    `    if (!space) throw new NotFoundException("Space not found");`,
    `  }`,
    ``,
    `  async b(orgId: string, spaceId: number) {`,
    `    const space = await this.db.query.kbSpaces.findFirst({`,
    `      where: and(`,
    `        eq(kbSpaces.id, spaceId),`,
    `        eq(kbSpaces.orgId, orgId),`,
    `        isNull(kbSpaces.deletedAt),`,
    `      ),`,
    `    });`,
    `    if (!space) throw new NotFoundException("Space not found");`,
    `  }`,
    ``,
    `  async c(orgId: string, slug: string) {`,
    `    const existing = await this.db.query.kbSpaces.findFirst({`,
    `      where: and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.slug, slug)),`,
    `    });`,
    `    if (existing) throw new ConflictException("Already exists");`,
    `  }`,
    ``,
    `  async d(userId: string) {`,
    `    const user = await this.db.query.users.findFirst({`,
    `      where: eq(users.id, userId),`,
    `    });`,
    `    if (!user) throw new NotFoundException("User not found");`,
    `  }`,
    ``,
    `  async e(orgId: string, id: number) {`,
    `    const row = await this.db.query.auditLogs.findFirst({`,
    `      where: and(eq(auditLogs.id, id), eq(auditLogs.orgId, orgId)),`,
    `    });`,
    `    if (!row) throw new NotFoundException("Not found");`,
    `  }`,
    ``,
    `  async f(read: ScopedRead, spaceId: number) {`,
    `    const space = await read.read(`,
    `      {`,
    `        tenant: kbSpaces.orgId,`,
    `        scope: { columns: { ownerColumn: kbSpaces.ownerId } },`,
    `        and: [eq(kbSpaces.id, spaceId), isNull(kbSpaces.deletedAt)],`,
    `      },`,
    `      ({ sql: where }) => this.db.query.kbSpaces.findFirst({ where, columns: { id: true } }),`,
    `      () => undefined,`,
    `    );`,
    `    if (!space) throw new NotFoundException("Space not found");`,
    `  }`,
    ``,
    `  async g(read: ScopedRead, spaceId: number) {`,
    `    const space = await read.read(`,
    `      {`,
    `        tenant: kbSpaces.orgId,`,
    `        scope: { columns: { ownerColumn: kbSpaces.ownerId } },`,
    `        and: [eq(kbSpaces.id, spaceId)],`,
    `      },`,
    `      ({ sql: where }) => this.db.query.kbSpaces.findFirst({ where, columns: { id: true } }),`,
    `      () => undefined,`,
    `    );`,
    `    if (!space) throw new NotFoundException("Space not found");`,
    `  }`,
    ``,
    `  async h(orgId: string, spaceId: number) {`,
    `    const space = await this.db.query.kbSpaces.findFirst({`,
    `      where: and(`,
    `        eq(kbSpaces.id, spaceId),`,
    `        eq(kbSpaces.orgId, orgId),`,
    `        supportArticlePredicate(),`,
    `      ),`,
    `    });`,
    `    if (!space) throw new NotFoundException("Space not found");`,
    `  }`,
  ].join("\n");

  const helperSource = [
    `export function supportArticlePredicate(): SQL {`,
    `  return sql\`(\${eq(kbSpaces.contentType, "x")} and \${isNull(kbSpaces.deletedAt)})\`;`,
    `}`,
    `export function contentTypeOnly(): SQL {`,
    `  return ne(kbSpaces.contentType, "x");`,
    `}`,
  ].join("\n");

  const helpers = softDeletePredicateHelpers([helperSource]);
  const found = parseFindFirst(source, schema, helpers);
  const foundBlind = parseFindFirst(source, schema);
  const at = (line) => found.find((f) => f.line === line);
  const offenders = found.filter(
    (f) =>
      f.shape === "read" &&
      schema[f.table].softDelete &&
      !f.hasSoftDelete &&
      !GLOBAL_TABLES.has(f.table),
  );

  const checks = {
    schemaSeesSoftDelete: schema["kbSpaces"].softDelete === true,
    schemaSeesTenant: schema["kbSpaces"].tenant === true,
    schemaSeesGlobalTableHasNoTenant: schema["users"].tenant === false,
    findsAllEightCalls: found.length === 8,
    helperResolvedFromItsBodyNotItsName: helpers.has("supportArticlePredicate"),
    helperWithoutSoftDeleteIsNotResolved: !helpers.has("contentTypeOnly"),
    helperComposedReadCountsAsGuarded: found[7]?.hasSoftDelete === true,
    helperWideningIsNotUnconditional: foundBlind[7]?.hasSoftDelete === false,
    unguardedReadIsAread: at(2)?.shape === "read" && at(2)?.hasSoftDelete === false,
    guardedReadPasses: at(9)?.shape === "read" && at(9)?.hasSoftDelete === true,
    scopedReadSpecIsInspected:
      found[5]?.hasSoftDelete === true && found[5]?.hasTenant === true,
    scopedReadMissingSoftDeleteStillFails: found[6]?.hasSoftDelete === false,
    scopedReadWideningIsNotUnconditional:
      scopedReadSpecFor("const x = 1;", 12, "{ where: eq(a.id, 1) }") === "",
    // The distinction that kept seven correct sites off the list
    conflictCheckIsNotARead: at(20)?.shape === "conflict",
    globalTableReadIsSeenButExempt: at(27)?.shape === "read" && GLOBAL_TABLES.has("users"),
    tableWithoutSoftDeleteIsNotAnOffender: !offenders.some((f) => f.table === "auditLogs"),
    exactlyTwoOffenders:
      offenders.length === 2 &&
      offenders[0].line === 2 &&
      offenders[1] === found[6],
    purgeRegistryIsExplicit: PURGE_READS.size > 0,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// -- run ---------------------------------------------------------------------

if (!existsSync(SCHEMA_DIR) || !existsSync(MODULES_DIR)) {
  process.stderr.write("Cannot read src/db/schema or src/modules\n");
  process.exit(2);
}

function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !SPEC_RE.test(entry.name)) out.push(full);
  }
  return out;
}

const schema = parseSchema(walkTs(SCHEMA_DIR).map((f) => readFileSync(f, "utf8")));

const sourceFiles = SCAN_DIRS.filter(existsSync).flatMap(walkTs);
const sourceText = new Map(sourceFiles.map((f) => [f, readFileSync(f, "utf8")]));
const softDeleteHelpers = softDeletePredicateHelpers(sourceText.values());

const reads = [];
for (const file of sourceFiles) {
  const rel = relative(BACKEND_ROOT, file).replace(/\\/g, "/");
  for (const f of parseFindFirst(sourceText.get(file), schema, softDeleteHelpers))
    reads.push({ ...f, file: rel });
}

if (reads.length < 200) {
  process.stderr.write(
    `Parser found only ${reads.length} findFirst calls. That is a broken parser, not a clean codebase.\n`,
  );
  process.exit(2);
}

const recordReads = reads.filter((r) => r.shape === "read");
const offenders = [];
const excused = [];
for (const r of recordReads) {
  if (!schema[r.table].softDelete || r.hasSoftDelete) continue;
  if (GLOBAL_TABLES.has(r.table)) continue;
  const key = `${r.file}::${r.table}`;
  if (PURGE_READS.has(key)) excused.push({ ...r, key });
  else offenders.push(r);
}

console.log(`findFirst calls        ${reads.length}`);
console.log(`  record reads         ${recordReads.length}`);
console.log(`  conflict checks      ${reads.filter((r) => r.shape === "conflict").length}`);
console.log(`  other                ${reads.filter((r) => r.shape === "other").length}`);
console.log("");

if (args.includes("--tenant")) {
  const noTenant = reads.filter((r) => schema[r.table].tenant && !r.hasTenant);
  console.log(`Reads on a tenant table with no application tenant predicate: ${noTenant.length}`);
  console.log("  Reported, not gated: RLS adds the predicate in the database, and the");
  console.log("  public, portal and platform paths have no tenant in context.");
  for (const r of noTenant) console.log(`  ${r.file}:${r.line}  ${r.table}`);
  console.log("");
}

if (excused.length > 0) {
  console.log("PURGE READS — named, not hidden in an allowlist:");
  for (const r of excused) console.log(`  SKIP  ${r.file}:${r.line}  ${r.table}  — ${PURGE_READS.get(r.key)}`);
  console.log("");
}

if (offenders.length === 0) {
  console.log("OK — every record read excludes soft-deleted rows.");
  process.exit(0);
}

console.error("A DELETED ROW CAN STILL BE READ:");
for (const r of offenders) console.error(`  FAIL  ${r.file}:${r.line}  ${r.table}  — add isNull(${r.table}.deletedAt)`);
console.error("");
console.error(`FAIL — ${offenders.length} record read(s) can return a deleted row.`);
process.exit(1);
