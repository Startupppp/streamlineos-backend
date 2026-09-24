import { escapeLikePattern, type ParamBag } from "../emit";
import { QueryCompilationError } from "../errors";
import {
  QUERY_LIMITS,
  UNARY_OPERATORS,
  BINARY_OPERATORS,
  LIST_OPERATORS,
  RANGE_OPERATORS,
  type ComparisonOperator,
} from "../query-description";
import type { ResolvedField } from "../compile.types";
import {
  BINARY_SET,
  CAST_FOR_TYPE,
  LIST_SET,
  OPERATORS_FOR_TYPE,
  OPERATOR_SET,
  RANGE_SET,
  UNARY_SET,
} from "./compile-rules";
import { qualified } from "./compile-resolution";
import { checkValue } from "./compile-values";

function isComparisonOperator(op: string): op is ComparisonOperator {
  return OPERATOR_SET.has(op);
}
function isUnaryOp(op: ComparisonOperator): op is (typeof UNARY_OPERATORS)[number] {
  return UNARY_SET.has(op);
}
function isBinaryOp(op: ComparisonOperator): op is (typeof BINARY_OPERATORS)[number] {
  return BINARY_SET.has(op);
}
function isListOp(op: ComparisonOperator): op is (typeof LIST_OPERATORS)[number] {
  return LIST_SET.has(op);
}
function isRangeOp(op: ComparisonOperator): op is (typeof RANGE_OPERATORS)[number] {
  return RANGE_SET.has(op);
}

// ── WHERE ────────────────────────────────────────────────────────────────────

export function compileWhere(
  filter: unknown,
  resolve: (name: unknown, path: string) => ResolvedField,
  params: ParamBag,
): string[] {
  if (filter === undefined || filter === null) return [];
  assertFilterIsWithinBudget(filter);
  return [compileFilterNode(filter, resolve, params, "filter")];
}

/**
 * Count the tree before compiling it.
 *
 * Two separate bounds, because they fail differently. Depth is a stack-overflow
 * risk — a recursive compile of a 50,000-deep tree crashes the process, which is
 * a denial of service reachable by a single request body. Node count is a
 * statement-size risk: a wide-but-shallow tree compiles fine and hands Postgres
 * a predicate with tens of thousands of terms to plan.
 *
 * The walk itself is iterative for exactly the reason it is checking: a
 * recursive depth-checker overflows on the input it exists to reject.
 */
function assertFilterIsWithinBudget(root: unknown): void {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  let nodes = 0;

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { node, depth } = frame;
    nodes += 1;

    if (nodes > QUERY_LIMITS.maxFilterNodes)
      throw new QueryCompilationError(
        "limit_exceeded",
        `filter may not exceed ${QUERY_LIMITS.maxFilterNodes} nodes`,
        "filter",
      );
    if (depth > QUERY_LIMITS.maxFilterDepth)
      throw new QueryCompilationError(
        "limit_exceeded",
        `filter may not nest deeper than ${QUERY_LIMITS.maxFilterDepth}`,
        "filter",
      );

    if (node === null || typeof node !== "object") continue;
    if ("nodes" in node && Array.isArray(node.nodes))
      for (const child of node.nodes) stack.push({ node: child, depth: depth + 1 });
    if ("node" in node && node.node !== undefined)
      stack.push({ node: node.node, depth: depth + 1 });
  }
}

function compileFilterNode(
  node: unknown,
  resolve: (name: unknown, path: string) => ResolvedField,
  params: ParamBag,
  path: string,
): string {
  if (node === null || typeof node !== "object")
    throw new QueryCompilationError("malformed_description", "filter node must be an object", path);

  if (!("kind" in node))
    throw new QueryCompilationError("malformed_description", "filter node must have a kind", path);

  switch (node.kind) {
    case "and":
    case "or": {
      if (!("nodes" in node) || !Array.isArray(node.nodes) || node.nodes.length === 0)
        throw new QueryCompilationError(
          "malformed_description",
          `${node.kind} requires a non-empty nodes array`,
          path,
        );
      const compiled = node.nodes.map((child, index) =>
        compileFilterNode(child, resolve, params, `${path}.nodes[${index}]`),
      );
      return `(${compiled.join(node.kind === "and" ? " AND " : " OR ")})`;
    }
    case "not": {
      if (!("node" in node) || node.node === undefined || node.node === null)
        throw new QueryCompilationError("malformed_description", "not requires a node", path);
      return `(NOT ${compileFilterNode(node.node, resolve, params, `${path}.node`)})`;
    }
    case "compare":
      return compileComparison(node, resolve, params, path);
    default:
      throw new QueryCompilationError(
        "malformed_description",
        `unknown filter node kind ${JSON.stringify(node.kind)}`,
        path,
      );
  }
}

function compileComparison(
  leaf: object,
  resolve: (name: unknown, path: string) => ResolvedField,
  params: ParamBag,
  path: string,
): string {
  if (
    !("operator" in leaf) ||
    typeof leaf.operator !== "string" ||
    !isComparisonOperator(leaf.operator)
  )
    throw new QueryCompilationError(
      "unknown_operator",
      `unknown operator ${JSON.stringify("operator" in leaf ? leaf.operator : undefined)}`,
      `${path}.operator`,
    );

  const operator = leaf.operator;

  if (!("field" in leaf))
    throw new QueryCompilationError(
      "malformed_description",
      "compare node must have a field",
      `${path}.field`,
    );

  const field = resolve(leaf.field, `${path}.field`);
  const column = qualified(field.alias, field.column);

  if (!OPERATORS_FOR_TYPE[field.type].has(operator))
    throw new QueryCompilationError(
      "operator_type_mismatch",
      `operator ${operator} does not apply to a ${field.type} field`,
      `${path}.operator`,
    );

  const cast = CAST_FOR_TYPE[field.type];
  const bind = (value: unknown, valuePath: string): string =>
    params.bind(checkValue(value, field.type, valuePath), cast);

  if (isUnaryOp(operator)) return `${column} IS ${operator === "is_null" ? "" : "NOT "}NULL`;

  if (isBinaryOp(operator)) {
    if (!("value" in leaf))
      throw new QueryCompilationError(
        "malformed_description",
        `operator ${operator} requires a value`,
        `${path}.value`,
      );

    const value = leaf.value;

    if (operator === "contains" || operator === "starts_with" || operator === "ends_with") {
      /**
       * `ILIKE`, not `LIKE`. A person searching a report for "acme" means the
       * company, whatever case it was typed in; a case-sensitive `contains` in a
       * reporting tool reads as a broken search rather than a precise one.
       *
       * The pattern is assembled *around* the escaped value and bound whole, so
       * the wildcards are ours and the value's own `%` is a percent sign.
       */
      if (typeof value !== "string")
        throw new QueryCompilationError(
          "value_type_mismatch",
          `operator ${operator} requires a string value`,
          `${path}.value`,
        );
      checkValue(value, field.type, `${path}.value`);
      const escaped = escapeLikePattern(value);
      const pattern =
        operator === "contains"
          ? `%${escaped}%`
          : operator === "starts_with"
            ? `${escaped}%`
            : `%${escaped}`;
      return `${column} ILIKE ${params.bind(pattern)}`;
    }

    const sqlOp = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[operator];
    return `${column} ${sqlOp} ${bind(value, `${path}.value`)}`;
  }

  if (isListOp(operator)) {
    if (!("values" in leaf) || !Array.isArray(leaf.values) || leaf.values.length === 0)
      /**
       * An empty list is refused rather than compiled. `IN ()` is a syntax
       * error, and the tempting fixes are both wrong: `IN (NULL)` matches
       * nothing but also makes `NOT IN` match nothing, and folding to a constant
       * `false` makes an empty filter silently mean "no rows" where the caller
       * probably meant "no filter".
       */
      throw new QueryCompilationError(
        "malformed_description",
        `operator ${operator} requires a non-empty values array`,
        `${path}.values`,
      );
    if (leaf.values.length > QUERY_LIMITS.maxInValues)
      throw new QueryCompilationError(
        "limit_exceeded",
        `${operator} may not carry more than ${QUERY_LIMITS.maxInValues} values`,
        `${path}.values`,
      );
    const placeholders = leaf.values.map((value, index) =>
      bind(value, `${path}.values[${index}]`),
    );
    return `${column} ${operator === "in" ? "IN" : "NOT IN"} (${placeholders.join(", ")})`;
  }

  if (isRangeOp(operator)) {
    if (!("from" in leaf) || !("to" in leaf))
      throw new QueryCompilationError(
        "malformed_description",
        "between requires both from and to",
        path,
      );
    return `${column} BETWEEN ${bind(leaf.from, `${path}.from`)} AND ${bind(leaf.to, `${path}.to`)}`;
  }

  /* istanbul ignore next — the operator set above is exhaustive. */
  throw new QueryCompilationError("unknown_operator", `unhandled operator ${operator}`, path);
}
