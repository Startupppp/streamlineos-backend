/**
 * AST scan for the shape PRD-C073 forbids in its own words:
 *
 *   "Implement existence/authorization probes with tenant-correlated indexed
 *    predicates and `LIMIT 1`; do not fetch records or counts when only existence
 *    is required."
 *
 * The sibling rules in `existence-paths.mjs` cover the "do not fetch RECORDS"
 * half — a whole row hydrated to answer a yes/no question. Nothing covered the
 * "do not fetch COUNTS" half, and that is the more expensive one: a row read is
 * bounded by the row, but `select({ total: count() }).from(t).where(org, status)`
 * with no `.limit(1)` aggregates the tenant's ENTIRE matching history to answer
 * "is there at least one?". Measured at head on this repository the worst case
 * was `accounting-settings.service.ts`, which counted every POSTED journal entry
 * in the organisation to decide whether the base currency may still change.
 *
 * WHAT IS A FINDING
 *   A drizzle `.select({...count()...})` whose result binding is consumed ONLY by
 *   a comparison against 0 or 1. That is a yes/no question by construction: the
 *   numeric value is never returned, rendered, summed or compared to anything but
 *   the existence threshold. Rewriting it as
 *   `select({ one: sql\`1\` }).from(t).where(...).limit(1)` changes no response
 *   DTO — exactly the property that makes this enforceable at zero rather than as
 *   a ratchet needing a product decision.
 *
 * WHAT IS NOT
 *   A count whose value is returned, stored, formatted, arithmetic'd or compared
 *   to anything else is a real count and is left alone — including a count that
 *   is ALSO compared to 0 somewhere, because the value still escapes.
 *
 * Why an AST. A regex over `count()` plus `> 0` cannot tell `total > 0` (a probe)
 * from `if (total > 0) return total;` (a real count reported to the caller), and
 * that distinction is the whole rule.
 */

import ts from "typescript";

/** Modules excluded from the 10/10 release — reported separately, never enforced here. */
export const OUT_OF_RELEASE_SCOPE = /[\\/]modules[\\/](crm|leads|deals|contacts|inventory)[\\/]/;

const COUNT_FUNCTIONS = new Set(["count", "countDistinct"]);
const COMPARISONS = new Set([
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
/** Only 0 and 1 are existence thresholds. `> 5` is a real count with a business rule. */
const EXISTENCE_THRESHOLDS = new Set(["0", "1"]);
/** Wrappers that carry the value along without consuming it. */
const NUMERIC_CASTS = new Set(["Number"]);

function isCountCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    COUNT_FUNCTIONS.has(node.expression.text)
  );
}

/** A `.select({ ... })` whose object literal contains a `count()` / `countDistinct()`. */
function selectIsCountAggregate(call) {
  if (!ts.isCallExpression(call)) return false;
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  if (call.expression.name.text !== "select") return false;
  const [arg] = call.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some((p) => ts.isPropertyAssignment(p) && isCountCall(p.initializer));
}

/**
 * The statement-level chain a `.select()` belongs to.
 *
 * Ascends only through the RECEIVER position — `x` in `x.from(...)`, `x` in `x(...)` — plus
 * `await` and parentheses. It must NOT ascend into a call that merely takes the chain as an
 * ARGUMENT (`this.countRows(db.select(...))`), because that call is a different expression
 * with a different result; conflating them is how a scan attributes one query's binding to
 * sixteen sibling queries.
 */
function chainRoot(node) {
  let current = node;
  for (;;) {
    const p = current.parent;
    if (!p) return current;
    if (ts.isPropertyAccessExpression(p) && p.expression === current) { current = p; continue; }
    if (ts.isCallExpression(p) && p.expression === current) { current = p; continue; }
    if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p)) { current = p; continue; }
    return current;
  }
}

function chainHasLimit(root) {
  let found = false;
  const walk = (n) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === "limit") found = true;
    ts.forEachChild(n, walk);
  };
  walk(root);
  return found;
}

function namesOf(bindingName) {
  if (ts.isIdentifier(bindingName)) return [bindingName.text];
  if (ts.isArrayBindingPattern(bindingName) || ts.isObjectBindingPattern(bindingName))
    return bindingName.elements
      .filter((e) => ts.isBindingElement(e) && ts.isIdentifier(e.name))
      .map((e) => e.name.text);
  return [];
}

/**
 * The name(s) the chain's result is bound to.
 *
 * Three shapes occur in this repository and each must land on its OWN binding:
 *   const [row] = await db.select({ total: count() })...       -> ["row"]
 *   const n = await this.countRows(db.select({ value: count() })...)  -> ["n"]
 *   const [a, b] = await Promise.all([helper(q1), helper(q2)]) -> q1 -> ["a"], q2 -> ["b"]
 * The third is index-mapped through the array literal; without that mapping every element of
 * a Promise.all inherits every binding, and one file of 16 probes reports as 240.
 * Anything else returns no binding, which means no finding — a false negative, never a false
 * positive, which is the right direction for a rule enforced at zero.
 */
function bindingNamesFor(root) {
  let node = root;
  for (;;) {
    const p = node.parent;
    if (!p) return [];
    if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p)) { node = p; continue; }
    if (ts.isCallExpression(p) && p.arguments.indexOf(node) !== -1) { node = p; continue; }
    if (ts.isArrayLiteralExpression(p)) {
      const idx = p.elements.indexOf(node);
      let outer = p.parent;
      if (outer && ts.isCallExpression(outer) && outer.arguments.indexOf(p) !== -1) outer = outer.parent;
      if (outer && ts.isAwaitExpression(outer)) outer = outer.parent;
      if (outer && ts.isVariableDeclaration(outer) && ts.isArrayBindingPattern(outer.name)) {
        const el = outer.name.elements[idx];
        // The element may itself be a pattern: `const [settings, [accountCount]] = await
        // Promise.all([...])` destructures the single-row array drizzle returns. Reading only
        // Identifier elements here silently skipped every probe written that way.
        if (el && ts.isBindingElement(el)) return namesOf(el.name);
      }
      return [];
    }
    if (ts.isVariableDeclaration(p)) return namesOf(p.name);
    return [];
  }
}

/**
 * Classify one reference to the count binding.
 * Returns "probe" when the value reaches a comparison against 0/1 and nothing else,
 * "real" otherwise.
 */
export function classifyCountReference(id) {
  let node = id;
  let parent = node.parent;
  while (parent) {
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      node = parent;
      parent = node.parent;
      continue;
    }
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent)
    ) {
      node = parent;
      parent = node.parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      node = parent;
      parent = node.parent;
      continue;
    }
    if (
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      NUMERIC_CASTS.has(parent.expression.text)
    ) {
      node = parent;
      parent = node.parent;
      continue;
    }
    if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) {
      const other = parent.left === node ? parent.right : parent.left;
      if (ts.isNumericLiteral(other) && EXISTENCE_THRESHOLDS.has(other.text)) return "probe";
      return "real";
    }
    return "real";
  }
  return "real";
}

/** The nearest enclosing function/method body, or the source file. */
function enclosingScope(node) {
  let n = node.parent;
  while (n && !ts.isFunctionDeclaration(n) && !ts.isMethodDeclaration(n) && !ts.isFunctionExpression(n) && !ts.isArrowFunction(n) && !ts.isSourceFile(n))
    n = n.parent;
  return n ?? node.getSourceFile();
}

/**
 * @returns findings: { file, line, binding, table }
 */
export function scanCountExistenceProbes(relPath, src) {
  const sf = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];

  const visit = (node) => {
    if (selectIsCountAggregate(node)) {
      const root = chainRoot(node);
      if (!chainHasLimit(root)) {
        const bindings = bindingNamesFor(root);
        if (bindings.length > 0) {
          const scope = enclosingScope(root);
          for (const binding of bindings) {
            const uses = [];
            const collect = (n) => {
              if (ts.isIdentifier(n) && n.text === binding && n !== root && !isDeclarationName(n))
                uses.push(n);
              ts.forEachChild(n, collect);
            };
            collect(scope);
            if (uses.length === 0) continue;
            if (uses.every((u) => classifyCountReference(u) === "probe")) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              findings.push({
                file: relPath,
                line: line + 1,
                binding,
                table: fromTable(root) ?? "unknown",
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function isDeclarationName(id) {
  const p = id.parent;
  return Boolean(
    p &&
      ((ts.isVariableDeclaration(p) && p.name === id) ||
        (ts.isBindingElement(p) && p.name === id) ||
        (ts.isPropertyAssignment(p) && p.name === id)),
  );
}

function fromTable(root) {
  let table = null;
  const walk = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "from" &&
      n.arguments.length === 1 &&
      ts.isIdentifier(n.arguments[0])
    )
      table = n.arguments[0].text;
    ts.forEachChild(n, walk);
  };
  walk(root);
  return table;
}
