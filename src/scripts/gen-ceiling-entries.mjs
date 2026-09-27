import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../", import.meta.url));

const ledgerRaw = readFileSync(join(SRC, "scripts/assertion-ceiling-ledger.json"), "utf8");
const ledger = JSON.parse(ledgerRaw);
const listed = new Set(Object.keys(ledger.files));

const SKIP_FILE = /\.(spec|e2e-spec|db\.spec|test)\.(ts|js)$|spec-fixtures\.ts$/;
const SKIP_DIRS = new Set(["node_modules", "__tests__", "__mocks__"]);

function countPlainAssertions(fileName, source) {
  const sf = ts.createSourceFile(
    fileName, source, ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let asX = 0;
  let nonNull = 0;

  const isConstAssertion = (t) =>
    ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.escapedText === "const";

  const visit = (node) => {
    if (ts.isAsExpression(node)) {
      if (isConstAssertion(node.type)) {
      } else if (node.type.kind === ts.SyntaxKind.UnknownKeyword && node.parent && ts.isAsExpression(node.parent)) {
      } else if (ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) {
      } else asX += 1;
    } else if (ts.isTypeAssertionExpression(node)) asX += 1;
    else if (ts.isNonNullExpression(node)) nonNull += 1;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { asX, nonNull };
}

function* walk(dir, depth = 0) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (depth === 0 && (entry.name === "dist" || entry.name === "coverage")) continue;
      yield* walk(full, depth + 1);
    } else if (entry.name.endsWith(".ts") && !SKIP_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

const results = [];
for (const file of walk(SRC)) {
  const rel = "src/" + relative(SRC, file).replace(/\\/g, "/");
  if (listed.has(rel)) continue;
  let source;
  try { source = readFileSync(file, "utf8"); } catch { continue; }
  const { asX, nonNull } = countPlainAssertions(file, source);
  if (asX > 0 || nonNull > 0) {
    results.push([rel, asX, nonNull]);
  }
}

results.sort((a, b) => a[0].localeCompare(b[0]));
process.stdout.write(`Found ${results.length} new files needing ceiling entries:\n`);
for (const [rel, asX, nonNull] of results) {
  process.stdout.write(`    "${rel}": { "as": ${asX}, "nonNull": ${nonNull} },\n`);
}
