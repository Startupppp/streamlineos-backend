import { ParamBag, quoteIdent } from "./emit";
import { QueryCompilationError } from "./errors";
import type { QueryDescription } from "./query-description";
import { BASE_ALIAS, REPORTING_REGISTRY, type JoinSpec } from "./registry";
import { assertRequesterScope, compileScopePredicate } from "./scope";
import type { CompileContext, CompiledQuery, ResolvedField } from "./compile.types";
import { emitJoin, lookupSource, qualified, resolveField } from "./lib/compile-resolution";
import { assertGroupingIsValid, compileGroupBy, compileSelect } from "./lib/compile-select";
import { compileWhere } from "./lib/compile-where";
import { compileOrderBy, compileWindow } from "./lib/compile-window";

export type { CompileContext, CompiledColumn, CompiledQuery } from "./compile.types";

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
//
// The clause compilers live in `lib/`: resolution and joins, SELECT and GROUP
// BY, WHERE, and ORDER BY with the row window; the operator and aggregate tables
// they consult are `lib/compile-rules.ts`. Each is reachable only through
// `compileQuery` — none of them binds the tenant or the requester's scope, which
// is why this function stays the one gate.

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
