import { getTableName } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { activities } from "../../../db/schema/crm/activities";
import { deals } from "../../../db/schema/crm/deals";
import { users } from "../../../db/schema/common/auth";
import { businessParties } from "../../../db/schema/party/business-parties";
import { subjects } from "../../../db/schema/party/subjects";
import { partyKindEnum, partyTypeEnum } from "../../../db/schema/common/enums";

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
 *
 * ---
 *
 * Every identifier below is now read off the Drizzle column object rather than
 * written out as a string, and that change is worth explaining because it looks
 * like tidying and is not.
 *
 * When the names were strings, this file could and did claim columns that do not
 * exist. It declared `activities` as tenanted on `org_id` owned by
 * `created_by_id` and keyed on `id`; the real table is tenanted on
 * `organization_id`, has no `created_by_id` at all — the actor column is
 * `actor_user_id` — and is keyed on `activity_id`. It declared `deals.closedAt`
 * as `closed_at`, which has never existed; the column is `actual_close_date`.
 * And it declared the `parties` primary key as `business_party_id` when it is
 * `party_id`, so the one join between the two most important entities in the
 * product pointed at nothing.
 *
 * None of that failed anywhere. A description naming those fields compiled
 * perfectly, because the compiler's job is to prove the description names things
 * the GRAPH declares, and the graph declared them. The failure arrived at the
 * database as `42703 undefined column`, which is precisely the shape ticket 14
 * asks us not to produce: a report that takes down a request with a Postgres
 * error instead of telling somebody what is wrong with their question.
 *
 * A test comparing this file to the schema would have caught it once. Binding to
 * the column object means it cannot recur: a column that does not exist is not a
 * failing assertion, it is a name that does not resolve, and a column that is
 * renamed carries its new physical name here without anyone remembering to.
 */
export type FieldType = "string" | "number" | "date" | "boolean" | "enum";

export interface FieldDefinition {
  /** The physical column. Never built from input, and never written by hand. */
  readonly column: string;
  readonly type: FieldType;
  /** Values a filter may compare against, for an enum. Anything else is refused. */
  readonly values?: readonly string[];
  /** Withheld from a report even though the column exists — see `deals.notes`. */
  readonly sensitive?: boolean;
}

/**
 * A reportable field, named by the column itself.
 *
 * `PgColumn` carries its own physical name, so the string this file needs is
 * derived rather than restated. The awkward-looking generic is doing one job:
 * accepting any column of any table without widening to `unknown`.
 */
function field(
  column: PgColumn,
  type: FieldType,
  extra: { readonly values?: readonly string[]; readonly sensitive?: boolean } = {},
): FieldDefinition {
  return { column: column.name, type, ...extra };
}

/**
 * An enum field whose permitted values come from the database enum itself.
 *
 * The old graph declared `parties.party_type` as taking `PERSON` or
 * `ORGANISATION`. Those are the values of a DIFFERENT enum — `party_kind` — and
 * `party_type` takes `CUSTOMER`, `VENDOR`, `PARTNER`, `BOTH`. So the compiler
 * refused every value the column can hold and accepted two it cannot, and both
 * halves of that were invisible until Postgres rejected the cast at run time.
 * Reading `enumValues` off the pgEnum removes the opportunity.
 */
function enumField(
  column: PgColumn,
  values: readonly string[],
  extra: { readonly sensitive?: boolean } = {},
): FieldDefinition {
  return { column: column.name, type: "enum", values, ...extra };
}

export interface JoinDefinition {
  /** The entity reached. */
  readonly to: string;
  /** Column on this entity. */
  readonly from: string;
  /** Column on the target. */
  readonly toColumn: string;
}

function join(to: string, from: PgColumn, toColumn: PgColumn): JoinDefinition {
  return { to, from: from.name, toColumn: toColumn.name };
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
  /**
   * Whether a description may name this entity as its root.
   *
   * `users` is global identity: it has no organisation column, so the tenancy
   * predicate has nothing true to say about it. As a join target that is fine —
   * it is reached from a row that already passed the predicate. As a root it is
   * not, and the previous version of this file papered over that by naming `id`
   * as the tenant column, which compiled to `users.id = $orgId` and returned
   * nothing because an organisation id is never a user id. Returning nothing by
   * arithmetic accident is not the same as being unreportable, and the next
   * person to add a global entity would have copied the trick.
   */
  readonly rootable: boolean;
  /**
   * The permission that governs seeing these rows outside a report.
   *
   * Not `crm:reports:view`, and the difference is ticket 12's entire subject.
   * "May this person open the reports screen" and "may this person see deals"
   * are different questions with different scopes, and a report that answers the
   * first and then reads deals is how a reporting surface becomes the way to
   * read what you are not allowed to read. The scope applied to the query is
   * resolved from THIS key, per viewer, at view time.
   */
  readonly permission: string;
  /**
   * The soft-delete column, where the entity has one.
   *
   * Applied by the compiler, like tenancy, and for the same reason: a report
   * that counts deleted records is not a security problem, it is a correctness
   * problem, and it is the one that destroys trust in a reporting surface
   * fastest. Somebody deletes a duplicate deal, the pipeline total does not
   * move, and from then on every number the tool produces is checked by hand
   * against the screen — at which point the tool has no purpose.
   *
   * Every entity in this graph is soft-deletable, so this is not optional in
   * practice. It stays typed as nullable because the next entity added might
   * genuinely have no such column, and the alternative is somebody inventing a
   * name to satisfy the type.
   */
  readonly softDeleteColumn: string | null;
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  readonly joins?: Readonly<Record<string, JoinDefinition>>;
}

export const QUERY_GRAPH: Readonly<Record<string, EntityDefinition>> = {
  deals: {
    table: getTableName(deals),
    tenantColumn: deals.orgId.name,
    ownerColumn: deals.assignedToId.name,
    rootable: true,
    permission: "crm:deals:read",
    softDeleteColumn: deals.deletedAt.name,
    fields: {
      id: field(deals.id, "number"),
      name: field(deals.name, "string"),
      /**
       * Deliberately `string`, not an enum, and this is a decision rather than
       * an omission.
       *
       * `deals.stage` is plain text holding a key from `crm_pipeline_stages`,
       * which every tenant configures for themselves. The seeded default deal
       * pipeline alone is LEAD, CONTACTED, PROPOSAL, NEGOTIATION, WON, LOST —
       * and the previous five-value list here omitted CONTACTED and NEGOTIATION,
       * so two of the six stages a brand-new organisation is created with could
       * not be filtered on. A tenant who renames a stage, or adds one, is in the
       * same position.
       *
       * Freezing a tenant-configurable vocabulary in a source file is how
       * ticket 13's "no engineering involvement" quietly stops being true: the
       * first custom stage turns a self-service report into a support ticket.
       */
      stage: field(deals.stage, "string"),
      /**
       * Minor units, like every other money column in the product.
       *
       * There is deliberately no `currency` field beside it, because `deals` has
       * no currency column — the previous graph declared one, and a report
       * selecting it died at the database. A deal is denominated in its
       * organisation's currency, which is a property of the tenant and the same
       * for every row a given report returns.
       */
      value: field(deals.valueMinor, "number"),
      probability: field(deals.probability, "number"),
      forecastCategory: field(deals.forecastCategory, "string"),
      createdAt: field(deals.createdAt, "date"),
      /** When it actually closed. Null while it is open, which is the point. */
      closedAt: field(deals.actualCloseDate, "date"),
      expectedCloseAt: field(deals.expectedCloseDate, "date"),
      /**
       * Free text a rep wrote for colleagues, not for a spreadsheet. Declared so
       * that the refusal is explicit and reasoned rather than an absence
       * somebody later mistakes for an oversight and "fixes".
       */
      notes: field(deals.notes, "string", { sensitive: true }),
    },
    joins: {
      owner: join("users", deals.assignedToId, users.id),
      party: join("parties", deals.partyId, businessParties.partyId),
    },
  },
  parties: {
    table: getTableName(businessParties),
    tenantColumn: businessParties.organizationId.name,
    ownerColumn: null,
    rootable: true,
    permission: "party:parties:view",
    softDeleteColumn: businessParties.deletedAt.name,
    fields: {
      id: field(businessParties.partyId, "string"),
      name: field(businessParties.name, "string"),
      /** Commercial relationship: customer, vendor, partner, or both. */
      partyType: enumField(businessParties.partyType, partyTypeEnum.enumValues),
      /** Person or company. The distinction the old graph confused with the above. */
      partyKind: enumField(businessParties.partyKind, partyKindEnum.enumValues),
      status: field(businessParties.status, "string"),
      createdAt: field(businessParties.createdAt, "date"),
    },
  },
  users: {
    table: getTableName(users),
    /**
     * `users` is global identity and has no organisation column at all, so this
     * names its own key and `rootable: false` is what actually keeps it safe.
     * The tenancy predicate is applied to the ROOT entity, and this entity can
     * never be one.
     */
    tenantColumn: users.id.name,
    ownerColumn: users.id.name,
    rootable: false,
    /*
      Reached only as a join target, so this is the permission that governs the
      records it is reached FROM. It is stated rather than omitted because
      `permission` is required: an entity nobody thought about the access rules
      for should not be declarable.
    */
    permission: "crm:deals:read",
    softDeleteColumn: users.deletedAt.name,
    fields: {
      id: field(users.id, "string"),
      name: field(users.name, "string"),
    },
  },
  activities: {
    table: getTableName(activities),
    tenantColumn: activities.organizationId.name,
    ownerColumn: activities.actorUserId.name,
    rootable: true,
    permission: "crm:activities:view",
    softDeleteColumn: activities.deletedAt.name,
    fields: {
      id: field(activities.activityId, "string"),
      kind: field(activities.kind, "string"),
      occurredAt: field(activities.occurredAt, "date"),
      source: field(activities.source, "string"),
      actorKind: field(activities.actorKind, "string"),
      /**
       * The text of an email, a note or a call transcript. Withheld for the same
       * reason `deals.notes` is, and more strongly: a timeline body is the single
       * richest store of personal data in the product, and a report is an export
       * surface.
       */
      body: field(activities.body, "string", { sensitive: true }),
    },
    /**
     * Only the party arm, and the missing one is a finding rather than a choice.
     *
     * `activities.deal_id` is `text` while `deals.id` is `serial`, so a join
     * between them is not `LEFT JOIN ... ON a.deal_id = d.id` returning nothing
     * — it is `42883 operator does not exist: text = integer`, a statement
     * Postgres refuses to plan. The old graph declared this join anyway.
     *
     * The mismatch is not confined to reporting: migration `0472` adds
     * `fk_activities_deal` on exactly this pair of columns, and Postgres cannot
     * create a foreign key between `text` and `integer` either. That migration
     * has therefore never taken effect, which means the timeline's deal anchor
     * has no referential integrity today despite a migration that says it does.
     * Repairing it is a real decision about which side changes type, on a hot
     * table, and it belongs to the timeline rather than to reports — so it is
     * reported and left alone rather than quietly worked around here.
     */
    joins: {
      party: join("parties", activities.partyId, businessParties.partyId),
    },
  },
  /**
   * The tenant's own record types.
   *
   * Ticket 16 asks that segments be expressible over "Party, Subject and
   * Activity", and Subject is the one that makes a segment worth having: it is
   * where a tenant's own vocabulary lives — a policy, a property, a matter, a
   * shipment — so a segment that cannot reach it can only ever describe people,
   * never the thing those people have with us.
   *
   * `customFields` is deliberately absent. It is JSONB whose keys are the
   * tenant's, and reporting into it means either building identifiers from
   * input — which this graph exists to prevent — or reading the type
   * definitions at compile time, which is a real feature and not this one.
   */
  subjects: {
    table: getTableName(subjects),
    tenantColumn: subjects.organizationId.name,
    ownerColumn: null,
    rootable: true,
    permission: "party:subjects:view",
    softDeleteColumn: subjects.deletedAt.name,
    fields: {
      id: field(subjects.subjectId, "string"),
      typeId: field(subjects.subjectTypeId, "string"),
      title: field(subjects.title, "string"),
      reference: field(subjects.reference, "string"),
      status: field(subjects.status, "string"),
      createdAt: field(subjects.createdAt, "date"),
    },
  },
};

export function entityDefinition(entity: string): EntityDefinition | null {
  return Object.prototype.hasOwnProperty.call(QUERY_GRAPH, entity)
    ? QUERY_GRAPH[entity]!
    : null;
}
