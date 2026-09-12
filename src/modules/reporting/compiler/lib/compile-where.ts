import { escapeLikePattern, type ParamBag } from "../emit";
import { QueryCompilationError } from "../errors";
import {
  QUERY_LIMITS,
  type ComparisonOperator,
  type FilterNode,
  type ScalarValue,
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

// ── WHERE ────────────────────────────────────────────────────────────────────

export function compileWhere(
  filter: unknown,
  resolve: (name: unknown, path: string) => ResolvedField,
  params: ParamBag,
): string[] {
  if (filter === undefined || filter === null) return [];
  assertFilterIsWithinBudget(filter);
  return [compileFilterNode(filter as FilterNode, resolve, params, "filter")];
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

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
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
    const shape = node as { kind?: unknown; nodes?: unknown; node?: unknown };
    if (Array.isArray(shape.nodes))
      for (const child of shape.nodes) stack.push({ node: child, depth: depth + 1 });
    if (shape.node !== undefined) stack.push({ node: shape.node, depth: depth + 1 });
  }
}

function compileFilterNode(
  node: FilterNode,
  resolve: (name: unknown, path: string) => ResolvedField,
  params: ParamBag,
  path: string,
): string {
  if (node === null || typeof node !== "object")
    throw new QueryCompilationError("malformed_description", "filter node must be an object", path);

  switch (node.kind) {
    case "and":
    case "or": {
      const children = node.nodes;
      if (!Array.isArray(children) || children.length === 0)
        throw new QueryCompilationError(
          "malformed_description",
          `${node.kind} requires a non-empty nodes array`,
          path,
        );
      const compiled = children.map((child, index) =>
        compileFilterNode(child, resolve, params, `${path}.nodes[${index}]`),
      );
      return `(${compiled.join(node.kind === "and" ? " AND " : " OR ")})`;
    }
    case "not": {
      if (node.node === undefined || node.node === null)
        throw new QueryCompilationError("malformed_description", "not requires a node", path);
      return `(NOT ${compileFilterNode(node.node, resolve, params, `${path}.node`)})`;
    }
    case "compare":
      return compileComparison(node, resolve, params, path);
    default:
      throw new QueryCompilationError(
        "malformed_description",
        `unknown filter node kind ${JSON.stringify((node as { kind?: unknown }).kind)}`,
        path,
      );
  }
}

function compileComparison(
  leaf: Extract<FilterNode, { kind: "compare" }>,
  resolve: (name: unknown, path: string) => ResolvedField,
  params: ParamBag,
  path: string,
): string {
  const operator: unknown = leaf.operator;
  if (typeof operator !== "string" || !OPERATOR_SET.has(operator))
    throw new QueryCompilationError(
      "unknown_operator",
      `unknown operator ${JSON.stringify(operator)}`,
      `${path}.operator`,
    );

  const field = resolve(leaf.field, `${path}.field`);
  const column = qualified(field.alias, field.column);

  if (!OPERATORS_FOR_TYPE[field.type].has(operator))
    throw new QueryCompilationError(
      "operator_type_mismatch",
      `operator ${operator} does not apply to a ${field.type} field`,
      `${path}.operator`,
    );

  const op = operator as ComparisonOperator;
  const cast = CAST_FOR_TYPE[field.type];
  const bind = (value: ScalarValue, valuePath: string): string =>
    params.bind(checkValue(value, field.type, valuePath), cast);

  if (UNARY_SET.has(op)) return `${column} IS ${op === "is_null" ? "" : "NOT "}NULL`;

  if (BINARY_SET.has(op)) {
    const value = (leaf as { value?: unknown }).value;
    if (value === undefined)
      throw new QueryCompilationError(
        "malformed_description",
        `operator ${op} requires a value`,
        `${path}.value`,
      );

    if (op === "contains" || op === "starts_with" || op === "ends_with") {
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
          `operator ${op} requires a string value`,
          `${path}.value`,
        );
      checkValue(value, field.type, `${path}.value`);
      const escaped = escapeLikePattern(value);
      const pattern =
        op === "contains" ? `%${escaped}%` : op === "starts_with" ? `${escaped}%` : `%${escaped}`;
      return `${column} ILIKE ${params.bind(pattern)}`;
    }

    const sqlOp = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[
      op as "eq" | "ne" | "lt" | "lte" | "gt" | "gte"
    ];
    return `${column} ${sqlOp} ${bind(value as ScalarValue, `${path}.value`)}`;
  }

  if (LIST_SET.has(op)) {
    const values = (leaf as { values?: unknown }).values;
    if (!Array.isArray(values) || values.length === 0)
      /**
       * An empty list is refused rather than compiled. `IN ()` is a syntax
       * error, and the tempting fixes are both wrong: `IN (NULL)` matches
       * nothing but also makes `NOT IN` match nothing, and folding to a constant
       * `false` makes an empty filter silently mean "no rows" where the caller
       * probably meant "no filter".
       */
      throw new QueryCompilationError(
        "malformed_description",
        `operator ${op} requires a non-empty values array`,
        `${path}.values`,
      );
    if (values.length > QUERY_LIMITS.maxInValues)
      throw new QueryCompilationError(
        "limit_exceeded",
        `${op} may not carry more than ${QUERY_LIMITS.maxInValues} values`,
        `${path}.values`,
      );
    const placeholders = values.map((value: unknown, index) =>
      bind(value as ScalarValue, `${path}.values[${index}]`),
    );
    return `${column} ${op === "in" ? "IN" : "NOT IN"} (${placeholders.join(", ")})`;
  }

  if (RANGE_SET.has(op)) {
    const { from, to } = leaf as { from?: unknown; to?: unknown };
    if (from === undefined || to === undefined)
      throw new QueryCompilationError(
        "malformed_description",
        "between requires both from and to",
        path,
      );
    return `${column} BETWEEN ${bind(from as ScalarValue, `${path}.from`)} AND ${bind(to as ScalarValue, `${path}.to`)}`;
  }

  /* istanbul ignore next — the operator set above is exhaustive. */
  throw new QueryCompilationError("unknown_operator", `unhandled operator ${op}`, path);
}
