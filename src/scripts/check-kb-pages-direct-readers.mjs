#!/usr/bin/env node
/**
 * check-kb-pages-direct-readers.mjs
 *
 * Fails when a file outside src/modules/kb/ imports the kb_pages schema.
 *
 * WHY THIS EXISTS
 * The Documents module has no enforceable interface: its interface is a
 * Postgres table. Nine modules read kb_pages directly — kb itself plus support,
 * billing, storage, public, hr, gdpr, cron and ai — so every visibility rule,
 * soft-delete predicate and tenant scope has to be re-remembered by each of
 * them. BE-04 says reach another module through its service, never its tables.
 *
 * That is not a style preference here. Measured on 2026-09-26, five of the
 * outside readers — ai/kb-rag-retrieval, public/kb.service, storage-kb.controller,
 * hr-helpdesk.service and support-kb-engagement.service — each hand-rolled their
 * own answer to "may this actor see this Document". None referenced
 * buildVisiblePageScope or KnowledgeAuthorizationService.
 *
 * The cost was concrete. A commit on 2026-09-09 made Space membership mandatory
 * for a Document inside a Space; a refactor on 2026-09-23 replaced that body
 * with a delegation whose predicate matched visibility IN ('org','public')
 * regardless of Space, and nothing went red for three days. A rule spread across
 * six implementations has nowhere to attach a regression test.
 *
 * WHAT FAILS THE GATE
 * A file outside src/modules/kb/ that imports kbPages from the schema barrel and
 * is not in the allowlist. Nothing else.
 *
 * WHAT DELIBERATELY DOES NOT
 *   INSIDE kb/ — direct table access is legitimate for the writer, the trash and
 *     purge paths, importing and indexing. Those are the module's own
 *     implementation, not a second interface. A separate ratchet for internal
 *     readers is deliberately NOT part of v1; it would flag legitimate access on
 *     day one and mean nothing until the wiki sub-module split lands.
 *   SPEC FILES — a spec constructs fixtures against the table on purpose.
 *   THE ALLOWLIST — seeded at the 13 files that existed when this gate was
 *     written. It may only shrink. Three billing entries are permanently exempt
 *     with a stated reason: plan-limit counting is tenant-wide by design, and
 *     making it visibility-dependent would let a low-visibility actor evade a
 *     cap. That reason lives in the allowlist so the next reviewer does not
 *     "fix" it.
 *
 * HOW TO CLEAR AN ENTRY
 * Point the caller at kb/core/authorization/knowledge-page-scope.ts —
 * visibleDocuments(standing, action) for an authenticated read,
 * publicVisibleDocuments(orgId) for anonymous — then delete its line here.
 * Porting a caller means adopting the canonical rule: moving a file behind the
 * port while it keeps its own predicate buys an import hop and nothing else.
 *
 * Usage:
 *   node src/scripts/check-kb-pages-direct-readers.mjs
 *   node src/scripts/check-kb-pages-direct-readers.mjs --self-test
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, "..", "..");
const MODULES = join(BACKEND, "src", "modules");
const ALLOWLIST = join(HERE, "kb-pages-direct-reader-allowlist.json");

const KB_PREFIX = "src/modules/kb/";

/** Matches an import of the kbPages schema symbol, in either import form. */
export const KB_PAGES_IMPORT_RE =
  /import\s+(?:type\s+)?\{[^}]*\bkbPages\b[^}]*\}\s*from\s*["'][^"']*db\/schema[^"']*["']/;

/**
 * Matches raw SQL naming the physical table. Without this the gate is defeated
 * by dropping to sql`` — which is not hypothetical: billing/plan-limits reads
 * `FROM kb_pages` in a raw count and imports nothing, so an import-only gate
 * reported it clean while it was re-deriving the soft-delete predicate by hand.
 */
export const KB_PAGES_RAW_SQL_RE =
  /\b(?:from|join|into|update)\s+"?kb_pages"?\b/i;

export function readsKbPagesSchema(source) {
  return KB_PAGES_IMPORT_RE.test(source) || KB_PAGES_RAW_SQL_RE.test(source);
}

/**
 * Matches a kb file handing the table object, or a column of it, back out under
 * another name. This is not hypothetical: on the first day this gate had teeth,
 * two independent lanes reached for exactly this to clear their allowlist line —
 * `export { kbPages }` and `export const proposedDocumentTable = kbPages`. Both
 * pass the import rule above while the outside module still holds the table and
 * still writes its own select, join and column list. An alias is still the
 * table, so a green gate would have been evidence of a port that never happened.
 */
export const KB_PAGES_REEXPORT_RE =
  /export\s+(?:const|let|var)\s+\w+(?:\s*:[^=]+?)?\s*=\s*kbPages\b|export\s*(?:type\s*)?\{[^}]*\bkbPages\b[^}]*\}/;

export function reexportsKbPagesTable(source) {
  return KB_PAGES_REEXPORT_RE.test(source);
}

export function findTableReexporters() {
  const offenders = [];
  for (const file of walk(MODULES)) {
    const rel = posix(relative(BACKEND, file));
    if (!rel.startsWith(KB_PREFIX)) continue;
    if (!reexportsKbPagesTable(readFileSync(file, "utf8"))) continue;
    offenders.push(rel);
  }
  return offenders.sort();
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".spec.ts") || entry.endsWith(".e2e-spec.ts")) continue;
    out.push(full);
  }
  return out;
}

function posix(p) {
  return p.split("\\").join("/");
}

export function findDirectReaders() {
  const offenders = [];
  for (const file of walk(MODULES)) {
    const rel = posix(relative(BACKEND, file));
    if (rel.startsWith(KB_PREFIX)) continue;
    if (!readsKbPagesSchema(readFileSync(file, "utf8"))) continue;
    offenders.push(rel);
  }
  return offenders.sort();
}

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  if (!Array.isArray(raw.allowed) || raw.allowed.length === 0) {
    throw new Error("allowlist is missing its `allowed` array");
  }
  return raw;
}

function main() {
  const { allowed } = loadAllowlist();
  const actual = findDirectReaders();
  const reexporters = findTableReexporters();

  if (reexporters.length > 0) {
    console.error(
      `check-kb-pages-direct-readers: ${reexporters.length} file(s) inside src/modules/kb/ re-export the kb_pages table or one of its columns:`,
    );
    for (const f of reexporters) console.error(`  ${f}`);
    console.error(
      "\nAn alias is still the table. Re-exporting it lets an outside module keep",
    );
    console.error(
      "its own select, join and column list while this gate reports green.",
    );
    console.error(
      "Expose a function that returns an explicit projection instead.",
    );
    process.exit(1);
  }

  const unlisted = actual.filter((f) => !allowed.includes(f));
  const stale = allowed.filter((f) => !actual.includes(f));

  if (unlisted.length > 0) {
    console.error(
      `check-kb-pages-direct-readers: ${unlisted.length} file(s) outside src/modules/kb/ read kb_pages directly and are not allowlisted:`,
    );
    for (const f of unlisted) console.error(`  ${f}`);
    console.error(
      "\nPort the caller onto kb/core/authorization/knowledge-page-scope.ts.",
    );
    console.error(
      "Adding it to the allowlist is not the fix — that list may only shrink.",
    );
    process.exit(1);
  }

  if (stale.length > 0) {
    console.error(
      `check-kb-pages-direct-readers: ${stale.length} allowlist entr(ies) no longer read kb_pages. Delete them — the ratchet only counts if it tightens:`,
    );
    for (const f of stale) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log(
    `check-kb-pages-direct-readers: ${actual.length} direct reader(s) outside kb, all allowlisted (ratchet: ${allowed.length}).`,
  );
}

function selfTest() {
  const failures = [];
  const ok = (name, cond) => {
    if (!cond) failures.push(name);
  };

  ok(
    "detects a named import of kbPages",
    readsKbPagesSchema(`import { kbPages } from "../../db/schema";`),
  );
  ok(
    "detects kbPages alongside other symbols",
    readsKbPagesSchema(
      `import { kbPageGrants, kbPages, users } from "../../../db/schema";`,
    ),
  );
  ok(
    "detects a type-only import",
    readsKbPagesSchema(`import type { kbPages } from "../../db/schema";`),
  );
  ok(
    "does not fire on a different schema symbol",
    !readsKbPagesSchema(`import { kbSpaces } from "../../db/schema";`),
  );
  ok(
    "does not fire on a substring match",
    !readsKbPagesSchema(`import { kbPagesArchive } from "../../db/schema";`),
  );
  ok(
    "does not fire on a camelCase mention outside an import",
    !readsKbPagesSchema(`const t = "kbPages";`),
  );
  ok(
    "detects raw SQL naming the physical table, so sql`` does not defeat it",
    readsKbPagesSchema("sql`SELECT COUNT(*) FROM kb_pages WHERE org_id = $1`"),
  );
  ok(
    "does not fire on a longer physical table name",
    !readsKbPagesSchema("sql`SELECT 1 FROM kb_pages_archive`"),
  );
  ok(
    "detects a quoted table reference",
    readsKbPagesSchema('sql`UPDATE "kb_pages" SET views = views + 1`'),
  );
  ok(
    "does not fire on a catalog naming the table as data, not querying it",
    !readsKbPagesSchema(
      `{ id: "kb_pages", mechanism: "database-cascade", table: "kb_pages", keyedBy: "owner_membership_id" }`,
    ),
  );

  ok(
    "detects a bare re-export of the table",
    reexportsKbPagesTable(`export { kbPages };`),
  );
  ok(
    "detects a renamed re-export of the table",
    reexportsKbPagesTable(`export { kbPages as proposedDocumentTable };`),
  );
  ok(
    "detects the table bound to an exported const",
    reexportsKbPagesTable(`export const proposedDocumentTable = kbPages;`),
  );
  ok(
    "detects a single exported column of the table",
    reexportsKbPagesTable(`export const titleColumn = kbPages.title;`),
  );
  ok(
    "detects a re-export forwarded straight from the schema barrel",
    reexportsKbPagesTable(
      `export { kbPages } from "../../../db/schema";`,
    ),
  );
  ok(
    "does not fire on a plain import of the table, which is how kb uses it",
    !reexportsKbPagesTable(`import { kbPages } from "../../../db/schema";`),
  );
  ok(
    "does not fire on exporting a predicate built over the table",
    !reexportsKbPagesTable(
      `export function publicVisibleDocuments(orgId) { return eq(kbPages.orgId, orgId); }`,
    ),
  );
  ok(
    "does not fire on a longer symbol that merely starts with the table name",
    !reexportsKbPagesTable(`export { kbPagesArchive };`),
  );

  const { allowed, permanentlyExempt } = loadAllowlist();
  ok("allowlist has no duplicates", new Set(allowed).size === allowed.length);
  ok(
    "every permanently-exempt file is also in the allowlist",
    Object.keys(permanentlyExempt ?? {}).every((f) => allowed.includes(f)),
  );
  ok(
    "the gate can still see at least one real reader",
    findDirectReaders().length > 0,
  );
  ok(
    "kb's own files are never counted",
    !findDirectReaders().some((f) => f.startsWith(KB_PREFIX)),
  );

  if (failures.length > 0) {
    console.error("check-kb-pages-direct-readers self-test FAILED");
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log("check-kb-pages-direct-readers self-test passed");
}

if (process.argv.includes("--self-test")) selfTest();
else main();
