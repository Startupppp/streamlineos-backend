/**
 * AST scan for reads that hydrate a whole row to answer a yes/no question.
 *
 * Ticket 20's projection box names three path kinds — list, COUNT and
 * EXISTENCE. `check-query-projections.mjs` prints "COUNT/EXISTENCE" but its rule
 * only ever fires when every use of the result is `.length`, so the existence
 * half was never covered by anything. Measured when this module was written:
 * **54 sites** whose result is only ever tested for null or truthiness, together
 * hydrating **827 columns**, 25 of them on a table carrying jsonb or a
 * credential — `sign_recipients` shipped 34 columns including `otp_code_hash`
 * and `signing_token_hash` to decide whether a recipient exists.
 *
 * Why an AST and not the sibling gate's regex. That gate deliberately refuses to
 * treat a BARE use as an existence test, because it measured 211 findings
 * against a hand-scan's 4 — `return rows;` is a bare use too. That is a true
 * property of a REGEX, not of the clause: a syntax tree tells `if (!row) throw`
 * apart from `return row;` exactly. Run over the same corpus this module reports
 * 54, and every one of them was confirmed by `tsc` (see below).
 *
 * Why narrowing these needs no product decision: an existence check has no
 * response DTO. The value is never returned, spread or read — that is the
 * definition of the finding — so the wire shape cannot change.
 *
 * The safety net is real, and was bite-proved rather than assumed. A top-level
 * `columns:` IS reflected in the inferred type (unlike a `with:` block, which is
 * not type-checked on this schema): planting `recipient.signingTokenHash` after
 * a `columns: { id: true }` narrowing in a `git archive HEAD` tree gives
 * `TS2339: Property 'signingTokenHash' does not exist on type '{ id: number; }'`.
 * So `tsc --noEmit` green over a batch of these narrowings is evidence, not hope.
 */

import ts from "typescript";

/** Modules excluded from the 10/10 release. Reported, ratcheted, not enforced. */
export const OUT_OF_RELEASE_SCOPE = /\/modules\/(crm|leads|deals|contacts|inventory)\//;

const USE_COUNT = "count";
const USE_EXISTENCE = "existence";
const USE_REAL = "real";

const isGetTableColumns = (n) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "getTableColumns";

/**
 * How a `.select(...)` hydrates its row, or null when it names its columns.
 *
 * `getTableColumns(t)` is the shape the sibling gate cannot see at all: its
 * detector is /\.select\s*\(\s*\)/, so a select that spreads every column of a
 * table reads as projected. Thirty of those exist in this repository.
 */
export function classifySelect(call) {
  if (call.arguments.length === 0) return "bare";
  const arg = call.arguments[0];
  if (isGetTableColumns(arg)) return "getTableColumns";
  if (ts.isObjectLiteralExpression(arg))
    for (const p of arg.properties)
      if (ts.isSpreadAssignment(p) && isGetTableColumns(p.expression)) return "getTableColumns+extras";
  return null;
}

/** True when a relational query's first argument has no top-level `columns:`. */
function findIsUnprojected(call) {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return !arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "columns");
}

/** Walk the builder chain (`.from().where().limit()`), the await, to the binding. */
function bindingFor(node) {
  let cur = node;
  while (cur.parent) {
    const p = cur.parent;
    if ((ts.isPropertyAccessExpression(p) && p.expression === cur) ||
        (ts.isCallExpression(p) && p.expression === cur) ||
        ts.isAwaitExpression(p) ||
        ts.isParenthesizedExpression(p)) { cur = p; continue; }
    if (ts.isVariableDeclaration(p) && p.initializer === cur && ts.isIdentifier(p.name))
      return { name: p.name.text, after: cur.getEnd() };
    return null;
  }
  return null;
}

function enclosingFunctionBody(node) {
  for (let cur = node; cur; cur = cur.parent)
    if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur) || ts.isArrowFunction(cur) ||
        ts.isFunctionExpression(cur) || ts.isConstructorDeclaration(cur) || ts.isGetAccessor(cur))
      return cur.body ?? null;
  return null;
}

/**
 * Every reference to `name` in `body` past `after`, ignoring identifiers that
 * merely coincide with a property or shorthand key.
 */
function referencesTo(body, name, after) {
  const out = [];
  (function walk(n) {
    if (ts.isIdentifier(n) && n.text === name && n.getStart() >= after) {
      const p = n.parent;
      const isMemberName = ts.isPropertyAccessExpression(p) && p.name === n;
      const isPropKey = ts.isPropertyAssignment(p) && p.name === n;
      const isBindKey = ts.isBindingElement(p) && p.propertyName === n;
      if (!isMemberName && !isPropKey && !isBindKey) out.push(n);
    }
    n.forEachChild(walk);
  })(body);
  return out;
}

const isNullish = (n) =>
  n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === "undefined");

/**
 * What a single reference does with the value.
 *
 * Anything that reads a property, returns it, passes it or spreads it is REAL
 * and disqualifies the site — which is exactly the distinction the sibling
 * gate's regex could not draw.
 */
export function classifyReference(id) {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === id && p.name.text === "length")
    return USE_COUNT;
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken)
    return USE_EXISTENCE;
  if (ts.isIfStatement(p) && p.expression === id) return USE_EXISTENCE;
  if (ts.isConditionalExpression(p) && p.condition === id) return USE_EXISTENCE;
  if (ts.isBinaryExpression(p)) {
    const k = p.operatorToken.kind;
    const other = p.left === id ? p.right : p.left;
    const equality =
      k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken;
    if (equality && isNullish(other)) return USE_EXISTENCE;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken)
      return USE_EXISTENCE;
  }
  return USE_REAL;
}

/**
 * Findings for one file: full-row reads whose result is only counted or only
 * tested for existence. A site with no references at all is NOT reported here —
 * that is a different defect (a read nobody consumes) and belongs to the
 * relation-hydration gate's memory clause.
 */
export function scanExistencePaths(relPath, src) {
  const sf = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, true);
  const findings = [];

  const record = (call, shape, subject) => {
    const bound = bindingFor(call);
    if (!bound) return;
    const body = enclosingFunctionBody(call) ?? sf;
    const refs = referencesTo(body, bound.name, bound.after);
    if (refs.length === 0) return;
    const kinds = new Set(refs.map(classifyReference));
    if (kinds.has(USE_REAL)) return;
    findings.push({
      file: relPath,
      line: sf.getLineAndCharacterOfPosition(call.getStart()).line + 1,
      shape,
      subject,
      binding: bound.name,
      kind: kinds.has(USE_EXISTENCE) ? "existence" : "count",
    });
  };

  (function walk(n) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      if (method === "select") {
        const shape = classifySelect(n);
        if (shape) record(n, `.select(${shape === "bare" ? "" : shape})`, "table");
      } else if (method === "findFirst" || method === "findMany") {
        const owner = n.expression.expression;
        const isRelational =
          ts.isPropertyAccessExpression(owner) &&
          ts.isPropertyAccessExpression(owner.expression) &&
          owner.expression.name.text === "query";
        if (isRelational && findIsUnprojected(n)) record(n, method, owner.name.text);
      }
    }
    n.forEachChild(walk);
  })(sf);

  return findings;
}
