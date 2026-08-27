/**
 * What a report may talk about, and how those things connect.
 *
 * Phase 5, ticket 10. The compiler can only emit what this graph declares, which
 * is what makes a hostile description uninteresting rather than dangerous: a
 * table nobody listed here has no name the compiler will accept, and a join
 * nobody declared has no path to express.
 *
 * Identifiers are the one thing that can never be parameterised — a table or
 * column name is part of the statement, not a value bound to it. So they are
 * never taken from input at all. Every identifier the compiler emits is read out
 * of this file, and the only thing a description supplies is a KEY into it.
 */
export type FieldType = "string" | "number" | "date" | "boolean" | "enum";

export interface FieldDefinition {
  /** The physical column. Never built from input. */
  readonly column: string;
  readonly type: FieldType;
  /** Values a filter may compare against, for an enum. Anything else is refused. */
  readonly values?: readonly string[];
  /** Withheld from a report even though the column exists — see `deals.stage_notes`. */
  readonly sensitive?: boolean;
}

export interface JoinDefinition {
  /** The entity reached. */
  readonly to: string;
  /** Column on this entity. */
  readonly from: string;
  /** Column on the target. */
  readonly toColumn: string;
}

export interface EntityDefinition {
  readonly table: string;
  /**
   * The column carrying the organisation.
   *
   * Required, and there is no way to declare an entity without one. Ticket 11
   * asks that a report cannot opt out of tenancy; the first half of that is that
   * nothing reportable exists without somewhere to put the predicate.
   */
  readonly tenantColumn: string;
  /** Whose row it is, for `own` scope. Null where the entity has no owner. */
  readonly ownerColumn: string | null;
  /** The department column for `team` scope, where the entity has one. */
  readonly teamColumn?: string | null;
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  readonly joins?: Readonly<Record<string, JoinDefinition>>;
}

export const QUERY_GRAPH: Readonly<Record<string, EntityDefinition>> = {
  deals: {
    table: "deals",
    tenantColumn: "org_id",
    ownerColumn: "assigned_to_id",
    fields: {
      id: { column: "id", type: "string" },
      name: { column: "name", type: "string" },
      stage: { column: "stage", type: "enum", values: ["LEAD", "QUALIFIED", "PROPOSAL", "WON", "LOST"] },
      value: { column: "value_minor", type: "number" },
      currency: { column: "currency", type: "string" },
      createdAt: { column: "created_at", type: "date" },
      closedAt: { column: "closed_at", type: "date" },
    },
    joins: {
      owner: { to: "users", from: "assigned_to_id", toColumn: "id" },
      party: { to: "parties", from: "party_id", toColumn: "business_party_id" },
    },
  },
  parties: {
    table: "business_parties",
    tenantColumn: "organization_id",
    ownerColumn: null,
    fields: {
      id: { column: "business_party_id", type: "string" },
      name: { column: "name", type: "string" },
      partyType: { column: "party_type", type: "enum", values: ["PERSON", "ORGANISATION"] },
      createdAt: { column: "created_at", type: "date" },
    },
  },
  users: {
    table: "users",
    // `users` is global identity, so a report reaches it only through a join
    // from something tenanted. The predicate below is applied to the ROOT entity,
    // which is why this can name a column that does not scope on its own.
    tenantColumn: "id",
    ownerColumn: "id",
    fields: {
      id: { column: "id", type: "string" },
      name: { column: "name", type: "string" },
    },
  },
  activities: {
    table: "activities",
    tenantColumn: "org_id",
    ownerColumn: "created_by_id",
    fields: {
      id: { column: "id", type: "string" },
      kind: { column: "kind", type: "string" },
      occurredAt: { column: "occurred_at", type: "date" },
    },
    joins: {
      deal: { to: "deals", from: "deal_id", toColumn: "id" },
    },
  },
};

export function entityDefinition(entity: string): EntityDefinition | null {
  return Object.prototype.hasOwnProperty.call(QUERY_GRAPH, entity)
    ? QUERY_GRAPH[entity]!
    : null;
}
