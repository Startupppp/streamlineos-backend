#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ts = require_("typescript");

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..");

const SKIP_DIRS = new Set(["node_modules", "__tests__", "__mocks__", "dist", "coverage"]);
const SKIP_FILE = /(\.spec\.ts|\.e2e-spec\.ts|\.db\.spec\.ts|\.test\.ts|spec-fixtures\.ts|\.d\.ts)$/;

const MIN_CHAINS_SCANNED = 5;
const MIN_FILES_WALKED = 500;

function* walk(dir, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (depth === 0 && (entry.name === "dist" || entry.name === "coverage")) continue;
      yield* walk(full, depth + 1);
    } else if (entry.name.endsWith(".ts") && !SKIP_FILE.test(entry.name)) {
      yield full;
    }
  }
}

function findSelectDistinctInChain(receiverExpr) {
  let cur = receiverExpr;
  while (cur) {
    if (ts.isCallExpression(cur)) {
      if (ts.isPropertyAccessExpression(cur.expression)) {
        const methodName = cur.expression.name.text;
        if (methodName === "selectDistinct") return cur;
        cur = cur.expression.expression;
      } else {
        break;
      }
    } else if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
    } else {
      break;
    }
  }
  return null;
}

function asColumnRef(node) {
  if (ts.isPropertyAccessExpression(node)) {
    const obj = node.expression;
    if (ts.isIdentifier(obj)) {
      return `${obj.text}.${node.name.text}`;
    }
  }
  return null;
}

function extractOrderByColumnRef(node) {
  const direct = asColumnRef(node);
  if (direct) return direct;
  if (ts.isCallExpression(node) && node.arguments.length >= 1) {
    return asColumnRef(node.arguments[0]);
  }
  return null;
}

function extractProjectionColumnRefs(objLiteral) {
  const refs = new Set();
  for (const prop of objLiteral.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const ref = asColumnRef(prop.initializer);
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

export function scanSource(relPath, source) {
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  let chainsScanned = 0;

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "orderBy"
    ) {
      const sdCall = findSelectDistinctInChain(node.expression.expression);
      if (sdCall) {
        chainsScanned++;
        const projArg = sdCall.arguments[0];
        if (!projArg || !ts.isObjectLiteralExpression(projArg)) {
          ts.forEachChild(node, visit);
          return;
        }
        const projRefs = extractProjectionColumnRefs(projArg);
        const badCols = [];
        for (const arg of node.arguments) {
          const ref = extractOrderByColumnRef(arg);
          if (ref && !projRefs.has(ref)) {
            badCols.push(ref);
          }
        }
        if (badCols.length > 0 && projRefs.size > 0) {
          const line = sf.getLineAndCharacterOfPosition(node.expression.name.getStart(sf)).line + 1;
          violations.push({ file: relPath, line, orderByCols: badCols, projRefs: [...projRefs] });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return { violations, chainsScanned };
}

function run() {
  const allViolations = [];
  let totalChains = 0;
  let filesWalked = 0;

  for (const file of walk(SRC)) {
    filesWalked++;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relPath = `src/${relative(SRC, file).replace(/\\/g, "/")}`;
    const { violations, chainsScanned } = scanSource(relPath, source);
    allViolations.push(...violations);
    totalChains += chainsScanned;
  }

  console.log(`Files walked: ${filesWalked}  chains scanned: ${totalChains}  violations: ${allViolations.length}`);

  if (filesWalked < MIN_FILES_WALKED) {
    console.error(
      `INCONCLUSIVE — walked ${filesWalked} files, below floor of ${MIN_FILES_WALKED}. The walker may be broken.`,
    );
    return 2;
  }

  if (totalChains < MIN_CHAINS_SCANNED) {
    console.error(
      `INCONCLUSIVE — only ${totalChains} selectDistinct...orderBy chain(s) found, below floor of ${MIN_CHAINS_SCANNED}. The detector may not be seeing the tree.`,
    );
    return 2;
  }

  for (const v of allViolations) {
    console.error(
      `FAIL ${v.file}:${v.line}  orderBy [${v.orderByCols.join(", ")}] not in selectDistinct projection [${v.projRefs.join(", ")}]`,
    );
  }

  if (allViolations.length === 0) {
    console.log("OK — every selectDistinct...orderBy chain orders by a projected column.");
    return 0;
  }
  return 1;
}

const SELF_TEST_FIXTURES = [
  {
    name: "DEFECT: orderBy column not in selectDistinct projection",
    source: `const rows = await db
      .selectDistinct({ membershipId: roleAssignments.organizationMembershipId })
      .from(roleAssignments)
      .innerJoin(organizationMembers, eq(organizationMembers.id, roleAssignments.organizationMembershipId))
      .orderBy(asc(organizationMembers.id));`,
    expect: (r) => r.violations.length === 1 && r.violations[0].orderByCols.includes("organizationMembers.id"),
  },
  {
    name: "SAFE: orderBy column is the same as the projected value",
    source: `const rows = await db
      .selectDistinct({ membershipId: roleAssignments.organizationMembershipId })
      .from(roleAssignments)
      .orderBy(asc(roleAssignments.organizationMembershipId));`,
    expect: (r) => r.violations.length === 0 && r.chainsScanned === 1,
  },
  {
    name: "SAFE: orderBy column is one of multiple projected values",
    source: `const rows = await db
      .selectDistinct({ membershipId: organizationMembers.id, userId: organizationMembers.userId })
      .from(organizationMembers)
      .orderBy(asc(organizationMembers.id));`,
    expect: (r) => r.violations.length === 0 && r.chainsScanned === 1,
  },
  {
    name: "SAFE: selectDistinct with no orderBy is not scanned",
    source: `const rows = await db
      .selectDistinct({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.orgId, orgId));`,
    expect: (r) => r.violations.length === 0 && r.chainsScanned === 0,
  },
  {
    name: "SAFE: plain select with orderBy is not scanned",
    source: `const rows = await db
      .select({ id: table.id })
      .from(table)
      .orderBy(asc(table.id));`,
    expect: (r) => r.violations.length === 0 && r.chainsScanned === 0,
  },
  {
    name: "SAFE: orderBy bare column reference without asc/desc is checked",
    source: `const rows = await db
      .selectDistinct({ action: auditLogs.action })
      .from(auditLogs)
      .orderBy(auditLogs.action);`,
    expect: (r) => r.violations.length === 0 && r.chainsScanned === 1,
  },
  {
    name: "DEFECT: one good arg and one bad arg in orderBy",
    source: `const rows = await db
      .selectDistinct({ userId: members.userId })
      .from(members)
      .orderBy(asc(members.userId), asc(members.createdAt));`,
    expect: (r) =>
      r.violations.length === 1 && r.violations[0].orderByCols.includes("members.createdAt") && !r.violations[0].orderByCols.includes("members.userId"),
  },
  {
    name: "SAFE: selectDistinctOn is not flagged (different method name, different SQL semantics)",
    source: `const rows = await db
      .selectDistinctOn([orgUnits.name], { name: orgUnits.name, id: orgUnits.id })
      .from(orgUnits)
      .orderBy(orgUnits.name, asc(orgUnits.id));`,
    expect: (r) => r.violations.length === 0 && r.chainsScanned === 0,
  },
  {
    name: "SAFE: orderBy sql template literal is skipped (no column ref extractable)",
    source: `const rows = await db
      .selectDistinct({ name: orgUnits.name })
      .from(orgUnits)
      .orderBy(sql\`lower(\${orgUnits.name})\`);`,
    expect: (r) => r.violations.length === 0 && r.chainsScanned === 1,
  },
  {
    name: "SAFE: long chain with joins and where still finds selectDistinct",
    source: `const rows = await db
      .selectDistinct({ roleId: rolePermissionGrants.roleId })
      .from(rolePermissionGrants)
      .innerJoin(roles, eq(roles.id, rolePermissionGrants.roleId))
      .where(eq(rolePermissionGrants.orgId, orgId))
      .orderBy(asc(rolePermissionGrants.roleId))
      .limit(100);`,
    expect: (r) => r.violations.length === 0 && r.chainsScanned === 1,
  },
];

const MIN_FIXTURES = 10;

function selfTest() {
  let passed = 0;
  let failed = 0;
  for (const fixture of SELF_TEST_FIXTURES) {
    let ok = false;
    let detail = "";
    try {
      const result = scanSource("fixture.ts", fixture.source);
      ok = fixture.expect(result) === true;
      if (!ok) detail = JSON.stringify({ violations: result.violations, chainsScanned: result.chainsScanned });
    } catch (error) {
      detail = String(error);
    }
    if (ok) {
      passed++;
      console.log(`  PASS ${fixture.name}`);
    } else {
      failed++;
      console.error(`  FAIL ${fixture.name}${detail ? `\n       ${detail}` : ""}`);
    }
  }

  if (SELF_TEST_FIXTURES.length < MIN_FIXTURES) {
    console.error(`SELF-TEST FAIL: only ${SELF_TEST_FIXTURES.length} fixtures, below floor of ${MIN_FIXTURES}`);
    return 1;
  }

  console.log(
    `\ncheck-distinct-order-by self-test: ${passed} passed, ${failed} failed (${SELF_TEST_FIXTURES.length} fixtures, floor ${MIN_FIXTURES})`,
  );
  return failed === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
process.exit(args.includes("--self-test") ? selfTest() : run());
