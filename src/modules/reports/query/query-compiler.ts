import type { DataScope } from "../../access/access.types";
import { entityDefinition, type EntityDefinition, type FieldDefinition } from "./query-graph";
import {
  AGGREGATIONS,
  FILTER_OPERATORS,
  type QueryDescription,
  type QueryFilter,
} from "./query-description";
import { assertWithinBounds } from "./query-bounds";
import { QueryDescriptionError } from "./query-errors";

export { QueryDescriptionError } from "./query-errors";
export { QueryBoundError, QUERY_BOUNDS } from "./query-bounds";

/**
 * Compiling a description into parameterised SQL.
 *
 * Phase 5, tickets 10 and 11. Two properties carry the whole design:
 *
 * **Identifiers are never taken from input.** A table or column name is part of
 * the statement and cannot be bound, so it is read out of `QUERY_GRAPH` by key.
 * A description supplies the key; if the key is unknown the compilation fails
 * with a message about the description. Nothing is escaped, because nothing
 * hostile ever reaches the string.
 *
 * **Tenancy is added here, not asked for.** `QueryDescription` has no field for
 * an organisation, a user or a scope, so a report cannot opt out — not because
 * opting out is rejected, but because it cannot be written down. The predicate
 * is appended to the WHERE of the root entity, before any grouping, so it
 * survives aggregation and sub-selects.
 */
export interface Requester {
  readonly orgId: string;
  readonly userId: string;
  readonly scope: DataScope;
  /** Departments the requester can see, for `team` scope. */
  readonly teamIds?: readonly string[];
}

export interface CompiledQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * The last line of defence, and it should never fire.
 *
 * Every identifier reaching this comes from `QUERY_GRAPH`, which is a source
 * file. If one ever fails this check, something is building identifiers from
 * input and the failure is a bug in the compiler rather than a hostile query.
 */
function safeIdentifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value))
    throw new QueryDescriptionError(`${what} is not a usable identifier: ${value}`);
  return `"${value}"`;
}

interface Resolved {
  readonly sql: string;
  readonly definition: FieldDefinition;
}

class Compilation {
  readonly params: unknown[] = [];
  private readonly aliases = new Map<string, EntityDefinition>();
  /*
    What the DESCRIPTION called each alias.

    Errors quote this rather than the alias. `t0` is the compiler's own name for
    the root and appears nowhere in what the caller wrote, so telling somebody
    that `nope` is not a field of `t0` answers a question they did not ask.
  */
  private readonly names = new Map<string, string>();

  constructor(
    private readonly root: EntityDefinition,
    private readonly rootAlias: string,
    rootName: string,
  ) {
    this.aliases.set(rootAlias, root);
    this.names.set(rootAlias, rootName);
  }

  private nameOf(alias: string): string {
    return this.names.get(alias) ?? alias;
  }

  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  addJoin(alias: string, definition: EntityDefinition): void {
    this.aliases.set(alias, definition);
    // A join is addressed by its declared key, which is what the caller wrote.
    this.names.set(alias, alias);
  }

  /** `field` on the root, or `join.field` through a join already added. */
  resolveField(path: string): Resolved {
    const parts = path.split(".");
    if (parts.length > 2)
      throw new QueryDescriptionError(`field path is not addressable: ${path}`);

    const [head, tail] = parts.length === 2 ? [parts[0]!, parts[1]!] : [this.rootAlias, parts[0]!];
    const entity = this.aliases.get(head);
    if (!entity)
      throw new QueryDescriptionError(
        `field "${path}" refers to "${head}", which this query does not join`,
      );

    const field = Object.prototype.hasOwnProperty.call(entity.fields, tail)
      ? entity.fields[tail]!
      : null;
    if (!field)
      throw new QueryDescriptionError(
        `"${tail}" is not a reportable field of "${this.nameOf(head)}"`,
      );
    if (field.sensitive)
      throw new QueryDescriptionError(`"${path}" is not available to reports`);

    return {
      sql: `${safeIdentifier(head, "alias")}.${safeIdentifier(field.column, "column")}`,
      definition: field,
    };
  }
}

function compileFilter(filter: QueryFilter, c: Compilation): string {
  if (!FILTER_OPERATORS.includes(filter.operator))
    throw new QueryDescriptionError(`unknown filter operator: ${String(filter.operator)}`);

  const { sql: column, definition } = c.resolveField(filter.field);

  if (filter.operator === "isNull") return `${column} IS NULL`;
  if (filter.operator === "isNotNull") return `${column} IS NOT NULL`;

  if (filter.operator === "in") {
    if (!Array.isArray(filter.value) || filter.value.length === 0)
      throw new QueryDescriptionError(`"in" on "${filter.field}" needs a non-empty list`);
    const placeholders = filter.value.map((v) => c.bind(assertValue(v, definition, filter.field)));
    return `${column} IN (${placeholders.join(", ")})`;
  }

  if (filter.value === undefined)
    throw new QueryDescriptionError(`"${filter.operator}" on "${filter.field}" needs a value`);

  if (filter.operator === "contains") {
    if (definition.type !== "string")
      throw new QueryDescriptionError(`"contains" only applies to text, not "${filter.field}"`);
    // The wildcards are ours; the value is still bound, so a value containing %
    // widens its own search and nothing else.
    return `${column} ILIKE ${c.bind(`%${String(filter.value)}%`)}`;
  }

  const operators: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  const operator = operators[filter.operator]!;
  return `${column} ${operator} ${c.bind(assertValue(filter.value, definition, filter.field))}`;
}

/** A value the field can actually hold. An enum accepts only what it declares. */
function assertValue(value: unknown, field: FieldDefinition, path: string): unknown {
  if (value === null) return null;
  if (field.type === "enum") {
    if (typeof value !== "string" || !field.values?.includes(value))
      throw new QueryDescriptionError(
        `"${String(value)}" is not one of the values "${path}" can take`,
      );
    return value;
  }
  if (field.type === "number" && typeof value !== "number")
    throw new QueryDescriptionError(`"${path}" takes a number`);
  if (field.type === "boolean" && typeof value !== "boolean")
    throw new QueryDescriptionError(`"${path}" takes true or false`);
  return value;
}

/**
 * Tenancy and scope, added by the compiler.
 *
 * Applied to the ROOT entity's alias. Joined entities are reached only through
 * declared joins from a row that already passed this predicate, so constraining
 * the root constrains everything the query can see.
 */
function tenancyPredicate(root: EntityDefinition, alias: string, who: Requester, c: Compilation): string {
  const a = safeIdentifier(alias, "alias");
  const clauses = [`${a}.${safeIdentifier(root.tenantColumn, "tenant column")} = ${c.bind(who.orgId)}`];

  /*
    Deleted rows, excluded here rather than left to the description.

    Not a security predicate — a deleted deal belongs to the tenant that deleted
    it — but the one that decides whether anybody trusts the tool. Somebody
    removes a duplicate deal, the pipeline total does not move, and every figure
    the reporting surface produces is checked by hand from then on. Placed with
    tenancy for the same reason tenancy is here: there is no field on a
    description in which to ask for deleted rows, so it cannot be turned off by
    accident or on purpose.
  */
  if (root.softDeleteColumn)
    clauses.push(`${a}.${safeIdentifier(root.softDeleteColumn, "soft delete column")} IS NULL`);

  switch (who.scope) {
    case "all":
      break;
    case "own": {
      if (!root.ownerColumn)
        throw new QueryDescriptionError(
          `"${root.table}" has no owner, so it cannot be reported at "own" scope`,
        );
      clauses.push(`${a}.${safeIdentifier(root.ownerColumn, "owner column")} = ${c.bind(who.userId)}`);
      break;
    }
    case "team": {
      const column = root.teamColumn;
      if (!column)
        throw new QueryDescriptionError(
          `"${root.table}" has no team column, so it cannot be reported at "team" scope`,
        );
      const ids = who.teamIds ?? [];
      if (ids.length === 0) {
        clauses.push("false");
        break;
      }
      clauses.push(
        `${a}.${safeIdentifier(column, "team column")} IN (${ids.map((id) => c.bind(id)).join(", ")})`,
      );
      break;
    }
    case "none":
      // Not an error: a scope of none is a legitimate answer to "what may this
      // person see", and the honest compilation of it is a query returning
      // nothing rather than a refusal the caller has to special-case.
      clauses.push("false");
      break;
  }

  return clauses.join(" AND ");
}

export function compileQuery(description: QueryDescription, who: Requester): CompiledQuery {
  /*
    Ticket 14's fifth criterion, and the reason it is the first line of the
    compiler rather than a check the caller performs: a bound the caller has to
    remember is a bound that is eventually bypassed by the one caller who does
    not. There is no compiled statement without this having run.
  */
  assertWithinBounds(description);

  const root = entityDefinition(description.entity);
  if (!root) throw new QueryDescriptionError(`"${description.entity}" is not a reportable entity`);
  /*
    Global entities are reachable, but only from a row that already passed the
    tenancy predicate. See `rootable` in the graph: naming one as the root would
    apply an organisation predicate to a column that does not carry an
    organisation.
  */
  if (!root.rootable)
    throw new QueryDescriptionError(
      `"${description.entity}" can only be reported through a related record, not on its own`,
    );

  const alias = "t0";
  const c = new Compilation(root, alias, description.entity);

  const joinClauses: string[] = [];
  for (const key of description.joins ?? []) {
    const join = root.joins?.[key];
    if (!join)
      throw new QueryDescriptionError(
        `"${description.entity}" has no declared join called "${key}"`,
      );
    const target = entityDefinition(join.to);
    if (!target) throw new QueryDescriptionError(`join "${key}" points at an unknown entity`);

    c.addJoin(key, target);
    /*
      The soft-delete predicate on a joined entity belongs in the ON clause, not
      the WHERE. In the WHERE it would turn the LEFT JOIN into an inner one and
      silently drop every root row whose related record had been deleted — so
      deleting one company would remove its deals from a report about deals.
    */
    const alive = target.softDeleteColumn
      ? ` AND ${safeIdentifier(key, "alias")}.${safeIdentifier(target.softDeleteColumn, "soft delete column")} IS NULL`
      : "";
    joinClauses.push(
      `LEFT JOIN ${safeIdentifier(target.table, "table")} AS ${safeIdentifier(key, "alias")}` +
        ` ON ${safeIdentifier(alias, "alias")}.${safeIdentifier(join.from, "column")}` +
        ` = ${safeIdentifier(key, "alias")}.${safeIdentifier(join.toColumn, "column")}${alive}`,
    );
  }

  const selected: string[] = [];
  for (const field of description.select ?? []) {
    const resolved = c.resolveField(field);
    selected.push(`${resolved.sql} AS ${safeIdentifier(field.replace(".", "_"), "output name")}`);
  }
  for (const aggregation of description.aggregations ?? []) {
    if (!AGGREGATIONS.includes(aggregation.of))
      throw new QueryDescriptionError(`unknown aggregation: ${String(aggregation.of)}`);
    const inner =
      aggregation.of === "count" && !aggregation.field
        ? "*"
        : c.resolveField(
            aggregation.field ??
              (() => {
                throw new QueryDescriptionError(`"${aggregation.of}" needs a field`);
              })(),
          ).sql;
    selected.push(
      `${aggregation.of.toUpperCase()}(${inner}) AS ${safeIdentifier(aggregation.as, "output name")}`,
    );
  }
  if (selected.length === 0) selected.push(`${safeIdentifier(alias, "alias")}.*`);

  // Tenancy first, so it is present whatever the description's filters do.
  const where = [tenancyPredicate(root, alias, who, c)];
  for (const filter of description.filters ?? []) where.push(compileFilter(filter, c));

  const groupBy = (description.groupBy ?? []).map((field) => c.resolveField(field).sql);
  const orderBy = (description.orderBy ?? []).map((order) => {
    const direction = order.direction === "desc" ? "DESC" : "ASC";
    return `${c.resolveField(order.field).sql} ${direction}`;
  });

  /*
    Already validated by `assertWithinBounds`; the default is applied here
    because an absent limit is not a bound violation, it is a description that
    did not say — and the honest reading of "did not say" is a page, not the
    maximum.
  */
  const limit = description.limit ?? 100;

  const text = [
    `SELECT ${selected.join(", ")}`,
    `FROM ${safeIdentifier(root.table, "table")} AS ${safeIdentifier(alias, "alias")}`,
    ...joinClauses,
    `WHERE ${where.join(" AND ")}`,
    groupBy.length ? `GROUP BY ${groupBy.join(", ")}` : "",
    orderBy.length ? `ORDER BY ${orderBy.join(", ")}` : "",
    `LIMIT ${c.bind(limit)}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { text, params: c.params };
}
