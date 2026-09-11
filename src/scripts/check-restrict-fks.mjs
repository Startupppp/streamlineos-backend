#!/usr/bin/env node
/**
 * check-restrict-fks.mjs
 *
 * WHAT IT CHECKS
 * Every RESTRICT (or NO ACTION) foreign key that references `organizationMembers`
 * must have an explicit ruling in MEMBERSHIP_ARTIFACTS — either a "blocks-removal"
 * entry (the departure path refuses until the dependency is cleared) or any other
 * onRemoval value (the departure/revocation path clears it programmatically).
 *
 * A RESTRICT FK to organization_members without a MEMBERSHIP_ARTIFACTS entry is a
 * silent blocker: member removal will throw 23001/23503 with no user-facing
 * explanation and no recovery path documented.
 *
 * HOW IT WORKS
 * 1. Walk every *.ts file under src/db/schema/.
 * 2. For each file, extract all foreignKey({...}).onDelete("restrict") blocks
 *    that reference organizationMembers in their foreignColumns.
 * 3. Determine the enclosing pgTable("table_name", ...) for each FK block.
 * 4. Parse src/modules/organization/core/membership-artifacts.ts for all
 *    artifact table names (any onRemoval value).
 * 5. Report any (table_name, constraint_name) pair that has no artifact entry.
 *
 * SELF-TEST (--self-test)
 * Runs synthetic schema + artifact text through the same detection functions and
 * asserts each expected outcome.
 *
 * Usage:
 *   node src/scripts/check-restrict-fks.mjs [--self-test]
 *   pnpm check:restrict-fks
 *   pnpm check:restrict-fks:self-test
 *
 * Exit codes:
 *   0 — clean (or self-test passed)
 *   1 — one or more uncovered RESTRICT FKs (or self-test failed)
 *   2 — no schema files found (working-directory issue), or self-test error
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_ROOT = join(__dirname, "..");
const SCHEMA_ROOT = join(SRC_ROOT, "db", "schema");
const ARTIFACTS_FILE = join(
  SRC_ROOT,
  "modules",
  "organization",
  "core",
  "membership-artifacts.ts",
);

/**
 * Schema files that are known to be NOT exported from the Drizzle barrel
 * (i.e., their tables are not live in the DB yet — pending hrms-phase1 or
 * other future migrations). These files may contain RESTRICT FKs to
 * organizationMembers, but since the tables aren't live those FKs can't
 * block a real member removal. Exclude them from the gate scan.
 *
 * When a file is promoted to the barrel, remove its entry here.
 */
const PENDING_SCHEMA_FILES = new Set([
  join(SRC_ROOT, "db", "schema", "directory", "workforce-periods.ts"),
  join(SRC_ROOT, "db", "schema", "hr", "workforce-legacy-maps.ts"),
  join(SRC_ROOT, "db", "schema", "hr", "workforce-reconciliation.ts"),
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

/**
 * Collapse a multi-line foreignKey({...}).onDelete("...") block onto one line.
 * Returns an array of logical "FK lines" from a file's content.
 */
function extractFkBlocks(content) {
  const blocks = [];
  let depth = 0;
  let inBlock = false;
  let start = -1;

  const lines = content.split("\n");
  let accumulated = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inBlock && /\bforeignKey\s*\(/.test(line)) {
      inBlock = true;
      start = i;
      accumulated = line;
      depth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      if (depth <= 0 && accumulated.includes("onDelete")) {
        blocks.push(accumulated.replace(/\s+/g, " ").trim());
        inBlock = false;
        accumulated = "";
      }
      continue;
    }

    if (inBlock) {
      accumulated += " " + line.trim();
      depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      if (depth <= 0) {
        if (accumulated.includes("onDelete")) {
          blocks.push(accumulated.replace(/\s+/g, " ").trim());
        }
        inBlock = false;
        accumulated = "";
        depth = 0;
      }
    }
  }

  return blocks;
}

/**
 * Parse a foreignKey block string and return { name, isRestrict, refsOrgMembers }.
 */
function parseFkBlock(block) {
  const nameMatch = block.match(/\bname\s*:\s*["']([^"']+)["']/);
  const name = nameMatch ? nameMatch[1] : "(unknown)";
  const isRestrict = /\.onDelete\s*\(\s*["']restrict["']\s*\)/.test(block);
  const refsOrgMembers = /organizationMembers/.test(block);
  return { name, isRestrict, refsOrgMembers };
}

/**
 * Find the enclosing table name for a character offset within file content.
 * Matches pgTable("name", ...) and schema.table("name", ...) patterns.
 */
function findEnclosingTable(content, fkBlockStart) {
  const before = content.slice(0, fkBlockStart);
  const tableRe = /(?:pgTable|\w+\.table)\s*\(\s*["']([^"']+)["']/g;
  let m;
  let last = null;
  while ((m = tableRe.exec(before)) !== null) last = m;
  return last ? last[1] : null;
}

/**
 * From a schema file's content, return all RESTRICT FK entries referencing
 * organizationMembers, with their enclosing table names.
 */
/**
 * Postgres defaults an FK with no ON DELETE clause to NO ACTION, which blocks
 * deletion exactly as RESTRICT does. The header of this gate has always claimed
 * to cover "RESTRICT (or NO ACTION)"; the matcher only ever tested for
 * `.onDelete("restrict")`, so 14 bare `foreignKey({})` blockers pointing at
 * organizationMembers were outside the scan while it reported OK.
 */
export function isBlockingAction(action) {
  if (action === null || action === undefined) return true;
  return /^(?:restrict|no[ _-]?action)$/i.test(String(action).trim());
}

export function isNonBlockingAction(action) {
  return !isBlockingAction(action);
}

function findRestrictFksInContent(content) {
  const found = [];
  let searchFrom = 0;

  const fkStartRe = /\bforeignKey\s*\(/g;
  let match;

  while ((match = fkStartRe.exec(content)) !== null) {
    const blockStart = match.index;
    let depth = 0;
    let i = match.index;
    let block = "";

    while (i < content.length) {
      const ch = content[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          block = content.slice(blockStart, i + 1);
          break;
        }
      }
      i++;
    }

    const rest = content.slice(i + 1, i + 30);
    const onDeleteMatch = rest.match(/^\.onDelete\s*\(\s*["']([^"']+)["']\s*\)/);
    const action = onDeleteMatch ? onDeleteMatch[1] : null;
    const fullBlock = action ? block + rest.slice(0, rest.indexOf(")") + 1) : block;

    if (isBlockingAction(action) && /organizationMembers/.test(block)) {
      const nameMatch = block.match(/\bname\s*:\s*["']([^"']+)["']/);
      const constraintName = nameMatch ? nameMatch[1] : "(unknown)";
      const tableName = findEnclosingTable(content, blockStart);
      found.push({ tableName, constraintName, action: action ?? "no action (implicit)" });
    }
  }

  return found;
}

/**
 * Parse MEMBERSHIP_ARTIFACTS source text and return all table names covered
 * (any onRemoval value).
 */
function parseCoveredTables(artifactsContent) {
  const tableNames = new Set();
  const tableRe = /\btable\s*:\s*["']([^"']+)["']/g;
  let m;
  while ((m = tableRe.exec(artifactsContent)) !== null) {
    tableNames.add(m[1]);
  }
  return tableNames;
}

function runScan(schemaRoot, artifactsContent, pendingFiles = PENDING_SCHEMA_FILES) {
  const schemaFiles = [];
  for (const f of walk(schemaRoot)) {
    if (!pendingFiles.has(f)) schemaFiles.push(f);
  }

  const coveredTables = parseCoveredTables(artifactsContent);
  const violations = [];

  for (const filePath of schemaFiles) {
    const content = readFileSync(filePath, "utf8");
    const fks = findRestrictFksInContent(content);
    for (const { tableName, constraintName } of fks) {
      if (!tableName || !coveredTables.has(tableName)) {
        violations.push({ filePath, tableName, constraintName });
      }
    }
  }

  return { schemaFiles, violations };
}

function selfTest() {
  console.log("--- check-restrict-fks self-test ---");
  let passed = 0;
  let failed = 0;

  function assert(label, actual, expected) {
    if (actual === expected) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label}`);
      console.error(`        expected: ${JSON.stringify(expected)}`);
      console.error(`        actual:   ${JSON.stringify(actual)}`);
      failed++;
    }
  }

  const RESTRICT_FK_TO_ORG_MEMBERS = `
export const fooTable = pgTable("foo_table", {
  orgId: text("org_id").notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
}, (table) => [
  foreignKey({
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_foo_table_created_actor",
  }).onDelete("restrict"),
]);
`;

  const SET_NULL_FK = `
export const barTable = pgTable("bar_table", {
  orgId: text("org_id").notNull(),
  approvedByMembershipId: integer("approved_by_membership_id"),
}, (table) => [
  foreignKey({
    columns: [table.orgId, table.approvedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_bar_table_approved_actor",
  }).onDelete("set null"),
]);
`;

  const RESTRICT_FK_NOT_TO_ORG_MEMBERS = `
export const bazTable = pgTable("baz_table", {
  orgId: text("org_id").notNull(),
  parentId: text("parent_id"),
}, (table) => [
  foreignKey({
    columns: [table.orgId, table.parentId],
    foreignColumns: [organizations.id, organizations.id],
    name: "fk_baz_table_org",
  }).onDelete("restrict"),
]);
`;

  const ARTIFACT_COVERING_FOO = `
export const MEMBERSHIP_ARTIFACTS = [
  {
    id: "foo_creator",
    table: "foo_table",
    onRemoval: "blocks-removal",
  },
] as const;
`;

  const ARTIFACT_NOT_COVERING_FOO = `
export const MEMBERSHIP_ARTIFACTS = [
  {
    id: "other",
    table: "other_table",
    onRemoval: "set-null",
  },
] as const;
`;

  const fks1 = findRestrictFksInContent(RESTRICT_FK_TO_ORG_MEMBERS);
  assert("detect RESTRICT FK to organizationMembers", fks1.length, 1);
  assert("extract constraint name", fks1[0]?.constraintName, "fk_foo_table_created_actor");
  assert("extract table name", fks1[0]?.tableName, "foo_table");

  const fks2 = findRestrictFksInContent(SET_NULL_FK);
  assert("do not flag SET NULL FK", fks2.length, 0);

  const fks3 = findRestrictFksInContent(RESTRICT_FK_NOT_TO_ORG_MEMBERS);
  assert("do not flag RESTRICT FK to non-org-members table", fks3.length, 0);

  const covered1 = parseCoveredTables(ARTIFACT_COVERING_FOO);
  assert("artifact covers foo_table", covered1.has("foo_table"), true);
  assert("artifact does not cover bar_table", covered1.has("bar_table"), false);

  const covered2 = parseCoveredTables(ARTIFACT_NOT_COVERING_FOO);
  assert("artifact does not cover foo_table when absent", covered2.has("foo_table"), false);

  const tmpSchemaDir = { _files: [RESTRICT_FK_TO_ORG_MEMBERS, SET_NULL_FK] };

  const fksFromMultiple = [
    ...findRestrictFksInContent(RESTRICT_FK_TO_ORG_MEMBERS),
    ...findRestrictFksInContent(SET_NULL_FK),
    ...findRestrictFksInContent(RESTRICT_FK_NOT_TO_ORG_MEMBERS),
  ];
  assert("combined scan: only one RESTRICT FK to org_members", fksFromMultiple.length, 1);

  const uncoveredViolation = fksFromMultiple.filter(
    (fk) => !covered2.has(fk.tableName ?? ""),
  );
  assert("violation when table not in artifacts", uncoveredViolation.length, 1);

  const coveredViolation = fksFromMultiple.filter(
    (fk) => !covered1.has(fk.tableName ?? ""),
  );
  assert("no violation when table is in artifacts", coveredViolation.length, 0);

  // NO ACTION blockers. A bare foreignKey({}) defaults to NO ACTION in Postgres
  // and blocks member removal exactly as RESTRICT does; the matcher only ever
  // tested for .onDelete("restrict"), so 14 of these were outside the scan while
  // the gate reported OK. The real one it now finds is
  // audit_logs.fk_audit_logs_org_actor_membership.
  const BARE_FK_TO_ORG_MEMBERS = `
export const quxTable = pgTable("qux_table", {
  orgId: text("org_id").notNull(),
  actorMembershipId: integer("actor_membership_id"),
}, (table) => [
  foreignKey({
    columns: [table.orgId, table.actorMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_qux_table_actor",
  }),
  index("idx_qux_org").on(table.orgId),
]);
`;
  const EXPLICIT_NO_ACTION_FK = `
export const quuxTable = pgTable("quux_table", {
  orgId: text("org_id").notNull(),
  actorMembershipId: integer("actor_membership_id"),
}, (table) => [
  foreignKey({
    columns: [table.orgId, table.actorMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_quux_table_actor",
  }).onDelete("no action"),
]);
`;
  const CASCADE_FK = `
export const corgeTable = pgTable("corge_table", {
  orgId: text("org_id").notNull(),
  actorMembershipId: integer("actor_membership_id"),
}, (table) => [
  foreignKey({
    columns: [table.orgId, table.actorMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_corge_table_actor",
  }).onDelete("cascade"),
]);
`;

  const bareFks = findRestrictFksInContent(BARE_FK_TO_ORG_MEMBERS);
  assert("a bare foreignKey({}) to organizationMembers is a blocker", bareFks.length, 1);
  assert("the bare blocker names its constraint", bareFks[0]?.constraintName, "fk_qux_table_actor");
  assert("the bare blocker names its table", bareFks[0]?.tableName, "qux_table");
  assert("the bare blocker records the implicit action", bareFks[0]?.action, "no action (implicit)");

  const explicitNoActionFks = findRestrictFksInContent(EXPLICIT_NO_ACTION_FK);
  assert("an explicit .onDelete(\"no action\") is a blocker", explicitNoActionFks.length, 1);
  assert("CASCADE is not a blocker", findRestrictFksInContent(CASCADE_FK).length, 0);

  assert("isBlockingAction: bare (null)", isBlockingAction(null), true);
  assert("isBlockingAction: restrict", isBlockingAction("restrict"), true);
  assert("isBlockingAction: no action", isBlockingAction("no action"), true);
  assert("isBlockingAction: NO ACTION uppercase", isBlockingAction("NO ACTION"), true);
  assert("isBlockingAction: no-action hyphen", isBlockingAction("no-action"), true);
  assert("isBlockingAction: set null", isBlockingAction("set null"), false);
  assert("isBlockingAction: cascade", isBlockingAction("cascade"), false);
  assert("isBlockingAction: set default", isBlockingAction("set default"), false);

  const bareUncovered = findRestrictFksInContent(BARE_FK_TO_ORG_MEMBERS).filter(
    (fk) => !parseCoveredTables(ARTIFACT_NOT_COVERING_FOO).has(fk.tableName ?? ""),
  );
  assert("a bare blocker with no artifact ruling is a violation", bareUncovered.length, 1);

  console.log(`\nSelf-test: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (SELF_TEST) {
  try {
    const ok = selfTest();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("Self-test error:", err);
    process.exit(2);
  }
}

let artifactsContent;
try {
  artifactsContent = readFileSync(ARTIFACTS_FILE, "utf8");
} catch {
  console.error(`Cannot read artifacts file: ${ARTIFACTS_FILE}`);
  process.exit(2);
}

const { schemaFiles, violations } = runScan(SCHEMA_ROOT, artifactsContent);

if (schemaFiles.length === 0) {
  console.error(`No schema files found under ${SCHEMA_ROOT} — check working directory.`);
  process.exit(2);
}

if (violations.length === 0) {
  console.log(`check:restrict-fks — OK (${schemaFiles.length} schema files scanned)`);
  process.exit(0);
}

console.error(
  `check:restrict-fks — FAIL: ${violations.length} RESTRICT FK(s) to organizationMembers have no ruling in MEMBERSHIP_ARTIFACTS:\n`,
);
for (const { filePath, tableName, constraintName } of violations) {
  const rel = relative(SRC_ROOT, filePath);
  console.error(`  table="${tableName}"  constraint="${constraintName}"`);
  console.error(`  file: ${rel}\n`);
}
console.error(
  "Fix: add an entry to membership-artifacts.ts for each table above, with an appropriate onRemoval value.",
);
process.exit(1);
