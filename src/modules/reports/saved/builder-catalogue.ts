import { QUERY_BOUNDS } from "../query/query-bounds";
import {
  AGGREGATIONS,
  type Aggregation,
  type FilterOperator,
} from "../query/query-description";
import { QUERY_GRAPH, type FieldType } from "../query/query-graph";

/**
 * What the builder is allowed to offer.
 *
 * Phase 5, ticket 13. The ticket's measure of success is stated in its last
 * criterion — "building a report requires no engineering involvement" — and the
 * way that stops being true is never a missing feature. It is a builder that
 * offers a choice the compiler then refuses.
 *
 * A person picks a field, picks "contains", types a number, and gets an error
 * about text operators. A person picks a stage from a list somebody hardcoded
 * and their own stages are not on it. A person picks eight groupings and hits a
 * bound nobody mentioned until after they had built the report. Each of those is
 * a support ticket, and enough of them turn a self-service tool into a request
 * queue with extra steps.
 *
 * So this file derives the offer from the same graph the compiler reads, rather
 * than describing it a second time. Which operators apply to a field is a
 * function of the field's TYPE, stated once, here, and used both to build the
 * menu and — in `builder-catalogue.spec.ts` — to prove that everything on the
 * menu compiles.
 */

/**
 * Which comparisons make sense for which kind of value.
 *
 * `contains` is absent from every type but `string` because the compiler refuses
 * it there, and offering it would be the exact failure described above.
 * `isNull`/`isNotNull` are on every type: "was this ever filled in" is a
 * question about any field, and for a date or a number it is often the most
 * useful one — an unset close date is the single best predictor of a forecast
 * nobody maintains.
 */
const ALWAYS: readonly FilterOperator[] = ["isNull", "isNotNull"] as const;

export const OPERATORS_FOR_TYPE: Readonly<Record<FieldType, readonly FilterOperator[]>> = {
  string: ["eq", "neq", "contains", "in", ...ALWAYS],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "in", ...ALWAYS],
  date: ["gt", "gte", "lt", "lte", ...ALWAYS],
  boolean: ["eq", ...ALWAYS],
  /** No `contains` and no ordering: an enum's values are labels, not a scale. */
  enum: ["eq", "neq", "in", ...ALWAYS],
} as const;

/**
 * Which totals make sense for which kind of value.
 *
 * `sum` and `avg` on a date would compile and return something meaningless, so
 * they are not offered. `min`/`max` on a date are the most useful aggregations
 * the product has — first touch, last touch — so they are.
 */
export const AGGREGATIONS_FOR_TYPE: Readonly<Record<FieldType, readonly Aggregation[]>> = {
  string: ["count", "min", "max"],
  number: ["count", "sum", "avg", "min", "max"],
  date: ["count", "min", "max"],
  boolean: ["count"],
  enum: ["count"],
} as const;

export interface CatalogueField {
  readonly key: string;
  readonly type: FieldType;
  /** Present only for an enum, and taken from the database enum itself. */
  readonly values?: readonly string[];
  readonly operators: readonly FilterOperator[];
  readonly aggregations: readonly Aggregation[];
  /** Whether it may be grouped by. Free text with millions of distinct values may not. */
  readonly groupable: boolean;
}

export interface CatalogueJoin {
  readonly key: string;
  readonly entity: string;
}

export interface CatalogueEntity {
  readonly key: string;
  readonly permission: string;
  readonly fields: readonly CatalogueField[];
  readonly joins: readonly CatalogueJoin[];
}

export interface BuilderCatalogue {
  readonly entities: readonly CatalogueEntity[];
  /**
   * Stated up front rather than discovered on submit — ticket 14's fourth
   * criterion read as a product requirement rather than an engineering one.
   */
  readonly bounds: typeof QUERY_BOUNDS;
}

/**
 * Whether grouping by this field produces a report or a copy of the table.
 *
 * A `GROUP BY` on a primary key or a free-text name returns one row per record,
 * which is not an aggregation, it is the unaggregated report with extra
 * machinery. Excluding them is not a safety rule — the compiler would happily
 * emit it — it is the difference between a menu that leads somewhere and a menu
 * that lets people build the wrong thing.
 */
function isGroupable(key: string, type: FieldType): boolean {
  if (key === "id") return false;
  if (type === "date") return false; // a timestamp groups into one row each
  if (key === "name" || key === "body" || key === "notes") return false;
  return true;
}

/**
 * The whole offer, derived.
 *
 * Sensitive fields are omitted rather than shown-and-refused. A field the
 * compiler will not report on has no business appearing in a menu: offering it
 * teaches people the tool is unreliable, and the refusal message is not an
 * explanation they asked for.
 */
export function builderCatalogue(): BuilderCatalogue {
  const entities: CatalogueEntity[] = [];

  for (const [key, entity] of Object.entries(QUERY_GRAPH)) {
    if (!entity.rootable) continue;

    const fields: CatalogueField[] = [];
    for (const [fieldKey, field] of Object.entries(entity.fields)) {
      if (field.sensitive) continue;
      fields.push({
        key: fieldKey,
        type: field.type,
        ...(field.values ? { values: field.values } : {}),
        operators: OPERATORS_FOR_TYPE[field.type],
        aggregations: AGGREGATIONS_FOR_TYPE[field.type],
        groupable: isGroupable(fieldKey, field.type),
      });
    }

    entities.push({
      key,
      permission: entity.permission,
      fields,
      joins: Object.entries(entity.joins ?? {}).map(([joinKey, join]) => ({
        key: joinKey,
        entity: join.to,
      })),
    });
  }

  return { entities, bounds: QUERY_BOUNDS };
}

/** Every aggregation the compiler knows, for a caller that wants the raw set. */
export const ALL_AGGREGATIONS: readonly Aggregation[] = AGGREGATIONS;
