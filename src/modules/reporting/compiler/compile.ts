import { ParamBag, escapeLikePattern, quoteIdent, type ParamValue } from "./emit";
import { QueryCompilationError } from "./errors";
import {
  AGGREGATES,
  BINARY_OPERATORS,
  COMPARISON_OPERATORS,
  LIST_OPERATORS,
  QUERY_LIMITS,
  RANGE_OPERATORS,
  SORT_DIRECTIONS,
  UNARY_OPERATORS,
  type Aggregate,
  type ComparisonOperator,
  type FieldType,
  type FilterNode,
  type Projection,
  type QueryDescription,
  type ScalarValue,
} from "./query-description";
import {
  BASE_ALIAS,
  REPORTING_REGISTRY,
  fieldsOf,
  joinsOf,
  type JoinSpec,
  type QueryRegistry,
  type SourceSpec,
} from "./registry";
import {
  assertRequesterScope,
  compileScopePredicate,
  type RequesterScope,
} from "./scope";
import type { DataScope } from "../../access/access.types";

/**
 * The compiler.
 *
 * A `QueryDescription` in, parameterised SQL out, and no database anywhere near
 * it. Pure in the strict sense — same input, same output, no clock, no
 * randomness, no I/O — which is what lets the adversarial specs run the real
 * production code path against hostile input thousands of times in milliseconds
 * instead of testing a mock of it.
 *
 * ## What makes this safe
 *
 * Three claims, each checked by a spec rather than asserted here:
 *
 * 1. **Values are never text.** Every literal goes through `ParamBag.bind` and
 *    appears in the statement only as `$n`. The consequence is testable without
 *    understanding the compiler at all: a compiled statement contains no single
 *    quote, so it contains no string literal, so there is nowhere for a tenant's
 *    string to be.
 * 2. **Identifiers are never caller input.** A caller sends names; names are
 *    looked up in the registry; the registry's own strings are emitted through
 *    `quoteIdent`, which refuses anything that is not a plain lowercase
 *    identifier. A miss is an error, never a fragment.
 * 3. **The tenant predicate is not part of the description.** `organizationId`
 *    is an argument to this function. No description can weaken, redirect or
 *    omit it, because no description can talk about it.
 * 4. **Neither is the requester's data scope.** `requester` is an argument too,
 *    and its predicate is appended by this function after the description's own
 *    filter has been compiled. A rep holding `crm:deals:read` at `own` gets a
 *    statement narrowed to their deals whatever their description said, because
 *    "and also show me everyone else's" is not a sentence `QueryDescription` can
 *    form. See `scope.ts`.
 *
 * ## Why it re-validates
 *
 * `QueryDescription` is a TypeScript type, and TypeScript is not present at
 * runtime. A description arriving from a saved report row is JSON that was
 * validated by whatever the DTO looked like on the day it was written, which may
 * not be today's DTO. So this function trusts nothing: it re-checks arity,
 * types, bounds and every name against the registry, and a caller that skips the
 * DTO entirely gets the same refusals. There is one gate and it is here.
 */

export interface CompiledColumn {
  /** The generated output alias, `c0`, `c1`, … Never caller-derived. */
  readonly alias: string;
  /** What the caller asked for, so it can label its own column. */
  readonly projection: Projection;
  readonly type: FieldType;
}

export interface CompiledQuery {
  /** Parameterised SQL. Contains `$n` placeholders and no literals. */
  readonly text: string;
  readonly params: readonly ParamValue[];
  readonly columns: readonly CompiledColumn[];
  /** Which registry source this reads, for the audit trail and the permission check. */
  readonly source: string;
  /**
   * The scope this statement was compiled under.
   *
   * Reported back rather than left for the caller to remember, so the audit row
   * records the scope that is *in the statement* rather than a variable that was
   * in scope at the call site. Those are the same value today; they stop being
   * the same value the first time somebody adds a branch, and an audit trail
   * that disagrees with the statement beside it is worse than no column.
   */
  readonly scope: DataScope;
}

const OPERATOR_SET = new Set<string>(COMPARISON_OPERATORS);
const UNARY_SET = new Set<string>(UNARY_OPERATORS);
const BINARY_SET = new Set<string>(BINARY_OPERATORS);
const LIST_SET = new Set<string>(LIST_OPERATORS);
const RANGE_SET = new Set<string>(RANGE_OPERATORS);
const AGGREGATE_SET = new Set<string>(AGGREGATES);
const DIRECTION_SET = new Set<string>(SORT_DIRECTIONS);

/**
 * The cast every value of a given type is bound under.
 *
 * `numeric` for all numbers, so a `bigint` money column and an `integer` score
 * compare identically and neither route goes through a float. There is no entry
 * for `text` — a text parameter needs no help, and `$1::text` on a `party_type`
 * enum column would fail where the bare parameter is inferred correctly.
 */
const CAST_FOR_TYPE: Partial<Record<FieldType, string>> = {
  number: "numeric",
  timestamp: "timestamp",
  date: "date",
  boolean: "boolean",
};

/** Which comparisons mean anything for which type. */
const OPERATORS_FOR_TYPE: Record<FieldType, ReadonlySet<string>> = {
  text: new Set([...UNARY_OPERATORS, ...BINARY_OPERATORS, ...LIST_OPERATORS, "between"]),
  /**
   * Membership and equality, and nothing else. An enum's values are a closed
   * set the tenant did not choose, so substring matching over them answers no
   * real question — and Postgres would reject it outright rather than run it
   * slowly. Ordering comparisons are excluded for the same reason they are
   * excluded on booleans: `party_type > $1` is legal, follows declaration order,
   * and means nothing anybody intended.
   */
  enum: new Set([...UNARY_OPERATORS, "eq", "ne", ...LIST_OPERATORS]),
  /**
   * Ordering and ranges, but no substring matching. `contains` on a number would
   * have to cast the column to text to work, which silently discards every index
   * on it — a filter that turns a report into a sequential scan of the table.
   */
  number: new Set([
    ...UNARY_OPERATORS,
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    ...LIST_OPERATORS,
    "between",
  ]),
  timestamp: new Set([
    ...UNARY_OPERATORS,
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "between",
  ]),
  date: new Set([...UNARY_OPERATORS, "eq", "ne", "lt", "lte", "gt", "gte", "between"]),
  /**
   * Equality and nullness only. `>` on a boolean is legal Postgres and means
   * nothing anybody intended.
   */
  boolean: new Set([...UNARY_OPERATORS, "eq", "ne"]),
};

/** Which aggregates mean anything for which type, and what they return. */
const AGGREGATE_RULES: Record<Aggregate, { readonly types: ReadonlySet<FieldType> | null }> = {
  /** Counting works on anything, including nothing — `COUNT(*)`. */
  count: { types: null },
  count_distinct: { types: null },
  sum: { types: new Set<FieldType>(["number"]) },
  avg: { types: new Set<FieldType>(["number"]) },
  /** Enums are omitted: Postgres orders them by declaration, which is not a fact about the business. */
  min: { types: new Set<FieldType>(["number", "timestamp", "date", "text"]) },
  max: { types: new Set<FieldType>(["number", "timestamp", "date", "text"]) },
};

const SQL_AGGREGATE: Record<Aggregate, string> = {
  count: "COUNT",
  count_distinct: "COUNT",
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX",
};

/** A field, resolved to something emittable. */
interface ResolvedField {
  readonly alias: string;
  readonly column: string;
  readonly type: FieldType;
  /** The join this came through, if any — so the compiler knows to emit it. */
  readonly join?: JoinSpec;
}

export interface CompileContext {
  readonly organizationId: string;
  /**
   * Who is asking, and how much they may see. Required, and deliberately not
   * optional-with-a-default: an optional `requester` defaulting to `all` is the
   * same thing as a description that can omit its scope, one indirection later.
   * Every call site has to state the answer, and `none` is a statable answer.
   */
  readonly requester: RequesterScope;
  readonly registry?: QueryRegistry;
}

export function compileQuery(
  description: QueryDescription,
  ctx: CompileContext,
): CompiledQuery {
  const registry = ctx.registry ?? REPORTING_REGISTRY;

  if (typeof ctx.organizationId !== "string" || ctx.organizationId.length === 0)
    /**
     * Not a validation nicety. An empty organisation id would compile to
     * `org_id = $1` with `$1` empty, which matches nothing today and would match
     * everything the day somebody "helpfully" made the predicate conditional.
     * Refusing here means there is no such day.
     */
    throw new QueryCompilationError(
      "malformed_description",
      "compileQuery requires a non-empty organizationId",
      "organizationId",
    );

  /**
   * Validated before the description is even looked at, for the same reason the
   * organisation id is: these two arguments are the statement's whole safety
   * story, and a compiler that checks them somewhere in the middle has a middle
   * where they are unchecked.
   */
  const requester = assertRequesterScope(ctx.requester);

  if (description === null || typeof description !== "object")
    throw new QueryCompilationError("malformed_description", "description must be an object");

  const source = lookupSource(registry, description.source);
  const params = new ParamBag();

  /**
   * Bound once and reused for every predicate that needs it — the base source's,
   * and each join's. One parameter rather than one per predicate so the audit
   * row's parameter count reflects the query's shape rather than its join count.
   */
  const orgParam = params.bind(ctx.organizationId);

  const usedJoins = new Map<string, JoinSpec>();
  const resolve = (name: unknown, path: string): ResolvedField => {
    const resolved = resolveField(source, name, path);
    if (resolved.join) usedJoins.set(resolved.join.alias, resolved.join);
    return resolved;
  };

  const { projections, columns } = compileSelect(description.select, resolve);
  const groupBy = compileGroupBy(description.groupBy, resolve);
  assertGroupingIsValid(description, columns);
  const where = compileWhere(description.filter, resolve, params);
  const orderBy = compileOrderBy(description.orderBy, columns);
  const { limit, offset } = compileWindow(description, params);

  const joinClauses = [...usedJoins.values()].map((join) =>
    emitJoin(join, orgParam),
  );

  /**
   * Compiled last, and appended after the description's own filter.
   *
   * "After" is the whole design and not an implementation detail. The
   * description has already had its say by this point — its filter is a finished
   * string in `where` — and these two terms are added to it by conjunction,
   * which no filter can undo: there is no `OR` a caller can write at the top of
   * their own tree that reaches outside the `AND` this line puts it inside.
   * Compare the alternative, where the tenant and scope terms are *defaults* the
   * description may override; that design is one careless merge away from a
   * report that reads another organisation, and no spec can prove the absence of
   * an override that the type system permits.
   */
  const scopePredicate = compileScopePredicate(source, requester, params, orgParam);

  const predicates = [
    `${qualified(BASE_ALIAS, source.organizationColumn)} = ${orgParam}`,
    ...(source.softDeleteColumn
      ? [`${qualified(BASE_ALIAS, source.softDeleteColumn)} IS NULL`]
      : []),
    ...where,
    scopePredicate,
  ];

  const text = [
    `SELECT ${projections.join(", ")}`,
    `FROM ${quoteIdent(source.table)} AS ${quoteIdent(BASE_ALIAS)}`,
    ...joinClauses,
    `WHERE ${predicates.join(" AND ")}`,
    ...(groupBy.length > 0 ? [`GROUP BY ${groupBy.join(", ")}`] : []),
    ...(orderBy.length > 0 ? [`ORDER BY ${orderBy.join(", ")}`] : []),
    `LIMIT ${limit}`,
    `OFFSET ${offset}`,
  ].join(" ");

  return {
    text,
    params: params.snapshot(),
    columns,
    source: description.source,
    scope: requester.scope,
  };
}

// ── Resolution ───────────────────────────────────────────────────────────────

function lookupSource(registry: QueryRegistry, name: unknown): SourceSpec {
  if (typeof name !== "string")
    throw new QueryCompilationError("malformed_description", "source must be a string", "source");
  const spec = registry.get(name);
  if (!spec)
    /**
     * The message names the *caller's* string but the string never reaches SQL,
     * only an error a person reads. Echoing it is what makes a typo diagnosable;
     * the reason that is safe is that this throw happens before any emit.
     */
    throw new QueryCompilationError(
      "unknown_source",
      `no queryable source named ${JSON.stringify(name)}`,
      "source",
    );
  return spec;
}

/**
 * A name to a column, or a refusal.
 *
 * `"stage"` is a field of the base source. `"party.industry"` is a field reached
 * through the join declared as `party`. Exactly one dot: a second one is not a
 * deeper path, it is a name with a dot in it, and there is no such field. That
 * matters more than it looks — "split on the first dot and treat the rest as a
 * path" is how a resolver acquires a recursive traversal nobody bounded.
 */
function resolveField(source: SourceSpec, name: unknown, path: string): ResolvedField {
  if (typeof name !== "string")
    throw new QueryCompilationError("malformed_description", "field must be a string", path);

  const parts = name.split(".");
  if (parts.length > 2)
    throw new QueryCompilationError(
      "unknown_field",
      `no field named ${JSON.stringify(name)}`,
      path,
    );

  if (parts.length === 1) {
    const field = fieldsOf(source).get(name);
    if (!field)
      throw new QueryCompilationError(
        "unknown_field",
        `source ${JSON.stringify(source.table)} has no field ${JSON.stringify(name)}`,
        path,
      );
    return { alias: BASE_ALIAS, column: field.column, type: field.type };
  }

  const [joinName, fieldName] = parts as [string, string];
  const join = joinsOf(source).get(joinName);
  if (!join)
    throw new QueryCompilationError(
      "unknown_field",
      `source ${JSON.stringify(source.table)} declares no relation ${JSON.stringify(joinName)}`,
      path,
    );
  const field = fieldsOf(join).get(fieldName);
  if (!field)
    throw new QueryCompilationError(
      "unknown_field",
      `relation ${JSON.stringify(joinName)} has no field ${JSON.stringify(fieldName)}`,
      path,
    );
  return { alias: join.alias, column: field.column, type: field.type, join };
}

const qualified = (alias: string, column: string): string =>
  `${quoteIdent(alias)}.${quoteIdent(column)}`;

/**
 * A join carries the tenant predicate too.
 *
 * On a `LEFT JOIN` the org predicate has to sit in the `ON` clause, not the
 * `WHERE`: in the `WHERE` it would discard the rows where the join found
 * nothing, quietly turning the outer join into an inner one and dropping every
 * deal with no party from the report. Putting it in `ON` is what keeps "left
 * join" and "tenant isolated" from being in tension.
 *
 * It is also not redundant with RLS. The policies are the backstop; this is the
 * predicate the planner can actually use an index for, and a report that scans
 * every tenant's rows before RLS filters them is a report that times out.
 */
function emitJoin(join: JoinSpec, orgParam: string): string {
  const conditions = [
    `${qualified(join.alias, join.foreignColumn)} = ${qualified(BASE_ALIAS, join.localColumn)}`,
    `${qualified(join.alias, join.organizationColumn)} = ${orgParam}`,
    ...(join.softDeleteColumn
      ? [`${qualified(join.alias, join.softDeleteColumn)} IS NULL`]
      : []),
  ];
  return `LEFT JOIN ${quoteIdent(join.table)} AS ${quoteIdent(join.alias)} ON ${conditions.join(" AND ")}`;
}

// ── SELECT ───────────────────────────────────────────────────────────────────

function compileSelect(
  select: unknown,
  resolve: (name: unknown, path: string) => ResolvedField,
): { projections: string[]; columns: CompiledColumn[] } {
  if (!Array.isArray(select) || select.length === 0)
    throw new QueryCompilationError(
      "malformed_description",
      "select must be a non-empty array",
      "select",
    );
  if (select.length > QUERY_LIMITS.maxSelect)
    throw new QueryCompilationError(
      "limit_exceeded",
      `select may not exceed ${QUERY_LIMITS.maxSelect} columns`,
      "select",
    );

  const projections: string[] = [];
  const columns: CompiledColumn[] = [];

  select.forEach((entry: unknown, index) => {
    const path = `select[${index}]`;
    if (entry === null || typeof entry !== "object")
      throw new QueryCompilationError("malformed_description", "projection must be an object", path);

    /**
     * The output alias is `c${index}` — generated here, never the caller's
     * label. A caller-chosen alias would be the one identifier in the statement
     * that came from outside the registry, which is precisely the hole this
     * module exists to not have. The caller gets its labels back in `columns`
     * and joins them to the rows by position.
     */
    const alias = `c${index}`;
    const projection = entry as Projection;

    if (projection.kind === "field") {
      const field = resolve(projection.field, `${path}.field`);
      projections.push(`${qualified(field.alias, field.column)} AS ${quoteIdent(alias)}`);
      columns.push({ alias, projection: { kind: "field", field: projection.field }, type: field.type });
      return;
    }

    if (projection.kind !== "aggregate")
      throw new QueryCompilationError(
        "malformed_description",
        "projection kind must be 'field' or 'aggregate'",
        path,
      );

    const aggregate = projection.aggregate;
    if (typeof aggregate !== "string" || !AGGREGATE_SET.has(aggregate))
      throw new QueryCompilationError(
        "unknown_aggregate",
        `unknown aggregate ${JSON.stringify(aggregate)}`,
        `${path}.aggregate`,
      );

    if (projection.field === undefined) {
      if (aggregate !== "count")
        throw new QueryCompilationError(
          "malformed_description",
          `aggregate ${aggregate} requires a field`,
          `${path}.field`,
        );
      projections.push(`COUNT(*) AS ${quoteIdent(alias)}`);
      columns.push({ alias, projection: { kind: "aggregate", aggregate }, type: "number" });
      return;
    }

    const field = resolve(projection.field, `${path}.field`);
    const allowed = AGGREGATE_RULES[aggregate].types;
    if (allowed !== null && !allowed.has(field.type))
      throw new QueryCompilationError(
        "operator_type_mismatch",
        `aggregate ${aggregate} does not apply to a ${field.type} field`,
        `${path}.aggregate`,
      );

    const inner = qualified(field.alias, field.column);
    const distinct = aggregate === "count_distinct" ? "DISTINCT " : "";
    projections.push(
      `${SQL_AGGREGATE[aggregate]}(${distinct}${inner}) AS ${quoteIdent(alias)}`,
    );
    columns.push({
      alias,
      projection: { kind: "aggregate", aggregate, field: projection.field },
      /** Counts and sums come back as numbers; min/max keep the column's type. */
      type:
        aggregate === "count" || aggregate === "count_distinct" || aggregate === "sum" || aggregate === "avg"
          ? "number"
          : field.type,
    });
  });

  return { projections, columns };
}

// ── GROUP BY ─────────────────────────────────────────────────────────────────

function compileGroupBy(
  groupBy: unknown,
  resolve: (name: unknown, path: string) => ResolvedField,
): string[] {
  if (groupBy === undefined) return [];
  if (!Array.isArray(groupBy))
    throw new QueryCompilationError("malformed_description", "groupBy must be an array", "groupBy");
  if (groupBy.length > QUERY_LIMITS.maxGroupBy)
    throw new QueryCompilationError(
      "limit_exceeded",
      `groupBy may not exceed ${QUERY_LIMITS.maxGroupBy} keys`,
      "groupBy",
    );
  return groupBy.map((name: unknown, index) => {
    const field = resolve(name, `groupBy[${index}]`);
    return qualified(field.alias, field.column);
  });
}

/**
 * Refuse a grouped projection Postgres would reject, before it reaches Postgres.
 *
 * The rule is the SQL one: once anything is aggregated, every bare column in the
 * projection must be grouped. Postgres enforces it too — the reason to do it
 * here is that its error arrives as a database exception at run time, after the
 * report was saved, shared and scheduled, whereas this one arrives at the moment
 * somebody builds the report. A saved report that has never run is the thing to
 * avoid; a compiler that only fails in production is how you get one.
 */
function assertGroupingIsValid(
  description: QueryDescription,
  columns: readonly CompiledColumn[],
): void {
  const hasAggregate = columns.some((c) => c.projection.kind === "aggregate");
  if (!hasAggregate) return;

  const groupedNames = new Set((description.groupBy ?? []).map(String));
  const ungrouped = columns
    .filter((c) => c.projection.kind === "field" && !groupedNames.has(c.projection.field))
    .map((c) => (c.projection.kind === "field" ? c.projection.field : ""));

  if (ungrouped.length > 0)
    throw new QueryCompilationError(
      "invalid_grouping",
      `these fields are selected alongside an aggregate but not grouped: ${ungrouped.join(", ")}`,
      "groupBy",
    );
}

// ── WHERE ────────────────────────────────────────────────────────────────────

function compileWhere(
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

/**
 * A value has to be the shape its column is.
 *
 * This is not about injection — a wrong-typed value is still a bind parameter
 * and still cannot become SQL. It is about the failure that happens instead: a
 * string where a number belongs reaches Postgres as `numeric` and raises a
 * *runtime* error inside the tenant's transaction, so the report fails when it
 * runs rather than when it is written. Checking here turns that into a 400 at
 * the moment of authoring.
 *
 * Timestamps and dates arrive as strings because JSON has no date. They are
 * checked for parseability, not reformatted — Postgres understands ISO 8601 and
 * the string is bound with an explicit cast, so there is nothing to normalise.
 */
function checkValue(value: unknown, type: FieldType, path: string): ParamValue {
  const mismatch = (expected: string): never => {
    throw new QueryCompilationError(
      "value_type_mismatch",
      `expected ${expected} for a ${type} field`,
      path,
    );
  };

  switch (type) {
    /**
     * Grouped with `text`: an enum value crosses the wire as a string and
     * Postgres infers the enum type from the column it is compared against. A
     * value naming no member of the enum is an error there, not here — this
     * compiler does not know the members, and inventing a second list of them
     * would be a second thing to keep in step with the database.
     */
    case "enum":
    case "text":
      if (typeof value !== "string") return mismatch("a string");
      /**
       * Postgres `text` cannot hold a NUL byte, so `postgres-js` raises on one
       * rather than sending it. Left unchecked, a filter value with an embedded
       * NUL becomes a driver exception inside the tenant's transaction — a 500
       * on what is plainly a bad request. Refusing here makes it a 400.
       *
       * It is not an injection: a NUL in a bind parameter is as inert as any
       * other byte. It is in the enumeration because it is the one value shape
       * the layers below this one cannot represent.
       */
      if (value.includes("\u0000")) return mismatch("a string without NUL bytes");
      if (value.length > QUERY_LIMITS.maxValueLength)
        throw new QueryCompilationError(
          "limit_exceeded",
          `text values may not exceed ${QUERY_LIMITS.maxValueLength} characters`,
          path,
        );
      return value;
    case "number":
      /**
       * `Number.isFinite` and not `typeof === "number"`: `NaN` and the
       * infinities are numbers, and `numeric` accepts `NaN`, where it compares
       * greater than everything. A filter of `value_minor < NaN` returning the
       * whole table is not a result anybody would question.
       */
      if (typeof value !== "number" || !Number.isFinite(value)) return mismatch("a finite number");
      return value;
    case "boolean":
      if (typeof value !== "boolean") return mismatch("a boolean");
      return value;
    case "timestamp":
    case "date": {
      if (typeof value !== "string") return mismatch("an ISO 8601 string");
      if (value.length > 40 || Number.isNaN(Date.parse(value)))
        return mismatch("a parseable ISO 8601 string");
      return value;
    }
  }
}

// ── ORDER BY, LIMIT, OFFSET ──────────────────────────────────────────────────

function compileOrderBy(
  orderBy: unknown,
  columns: readonly CompiledColumn[],
): string[] {
  if (orderBy === undefined) return [];
  if (!Array.isArray(orderBy))
    throw new QueryCompilationError("malformed_description", "orderBy must be an array", "orderBy");
  if (orderBy.length > QUERY_LIMITS.maxOrderBy)
    throw new QueryCompilationError(
      "limit_exceeded",
      `orderBy may not exceed ${QUERY_LIMITS.maxOrderBy} keys`,
      "orderBy",
    );

  return orderBy.map((entry: unknown, index) => {
    const path = `orderBy[${index}]`;
    if (entry === null || typeof entry !== "object")
      throw new QueryCompilationError("malformed_description", "sort spec must be an object", path);
    const { select, direction } = entry as { select?: unknown; direction?: unknown };

    if (typeof select !== "number" || !Number.isInteger(select) || select < 0 || select >= columns.length)
      throw new QueryCompilationError(
        "invalid_order_target",
        `orderBy must name the index of a selected column (0..${columns.length - 1})`,
        `${path}.select`,
      );
    if (typeof direction !== "string" || !DIRECTION_SET.has(direction))
      throw new QueryCompilationError(
        "malformed_description",
        `direction must be one of ${SORT_DIRECTIONS.join(", ")}`,
        `${path}.direction`,
      );

    /**
     * `NULLS LAST` in both directions, rather than Postgres's default of nulls
     * last ascending and first descending. A report sorted by "largest deal
     * first" should not open with a screen of deals that have no value, and a
     * default that flips with the direction means the same report reads
     * differently depending on which arrow was clicked.
     */
    return `${quoteIdent(columns[select]!.alias)} ${direction === "asc" ? "ASC" : "DESC"} NULLS LAST`;
  });
}

/**
 * The row window.
 *
 * Bound as parameters rather than inlined, even though they are integers this
 * function has just proved safe. Inlining "safe" numbers is how a statement
 * acquires its first concatenation, and the next person adds one beside it
 * without re-deriving the proof. Everything is a parameter; there is no
 * judgement call at the call site.
 */
function compileWindow(
  description: QueryDescription,
  params: ParamBag,
): { limit: string; offset: string } {
  const { limit, offset = 0 } = description;

  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
    throw new QueryCompilationError(
      "malformed_description",
      "limit must be a positive integer",
      "limit",
    );
  if (limit > QUERY_LIMITS.maxLimit)
    /**
     * Refused, not clamped. A silently clamped limit gives a caller a page of
     * results it believes is the whole answer, and a report that is quietly
     * truncated is worse than one that says it asked for too much.
     */
    throw new QueryCompilationError(
      "limit_exceeded",
      `limit may not exceed ${QUERY_LIMITS.maxLimit}`,
      "limit",
    );
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
    throw new QueryCompilationError(
      "malformed_description",
      "offset must be a non-negative integer",
      "offset",
    );
  if (offset > QUERY_LIMITS.maxOffset)
    throw new QueryCompilationError(
      "limit_exceeded",
      `offset may not exceed ${QUERY_LIMITS.maxOffset}`,
      "offset",
    );

  return { limit: params.bind(limit), offset: params.bind(offset) };
}
