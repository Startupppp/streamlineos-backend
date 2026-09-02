import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { FINDING_SEVERITIES, type FindingSeverity } from "./data-quality";

/**
 * Three record types, one table, and no bespoke module for any of them.
 *
 * `D27`. An issue the system raises about itself, a task a team assigns
 * internally, and a complaint a customer escalates are today three threads in
 * somebody's inbox. The instinct is three modules; the instinct is wrong. They
 * differ in who raises them and what they anchor to, and in nothing else — the
 * same severity, the same owner, the same clock, the same accountability for
 * who moved them and when. Three tables would be three bespoke modules wearing
 * one name, and a fourth record type would be a fourth migration.
 *
 * What makes one table honest is that the renderer takes its layout as data.
 * `subject_types` already proved it: a tenant's field declaration is the
 * renderer's `FieldSpec` minus presentation, so a declaration becomes a rendered
 * list, detail view and form with no translation layer. These three are the same
 * arrangement with the declaration held by the platform rather than the tenant —
 * see `modules/issues/issue-record-types.ts`, which is the single source both the
 * served layout and the row projection are generated from.
 */

/**
 * What raised the record, which is the only thing the three genuinely disagree
 * about.
 *
 * Lowercase, matching `DATA_QUALITY_PRODUCERS` and `FINDING_STATUSES` rather
 * than the uppercase enums the legacy CRM tables use, because a person moving
 * between the data-quality queue and this one should not be learning two
 * dialects for one idea.
 */
export const ISSUE_RECORD_TYPES = [
  /** The system raised it about itself: a failed sync, a stuck job, a drift. */
  "issue",
  /** A person assigned it to another person. Internal, no customer attached. */
  "task",
  /** A customer said something went wrong. Always anchored to a Party. */
  "complaint",
] as const;
export type IssueRecordType = (typeof ISSUE_RECORD_TYPES)[number];

/**
 * Where a record is, and the vocabulary escalation moves it through.
 *
 * `resolved` and `dismissed` are `FINDING_STATUSES` verbatim and keep that
 * table's distinction exactly: one says the thing was real and has been dealt
 * with, the other says it was not real. Collapsing them would make the raisers'
 * own accuracy unmeasurable, which is the argument `data-quality.ts` already
 * makes and this table has no reason to re-litigate.
 *
 * `escalated` is a stage like any other, and that is the point of criterion 4:
 * escalation is not a flag, a boolean or a parallel accountability model. It is
 * a transition, and it lands in the ledger below beside every other transition.
 */
export const ISSUE_STAGES = [
  "open",
  "acknowledged",
  "escalated",
  "resolved",
  "dismissed",
] as const;
export type IssueStage = (typeof ISSUE_STAGES)[number];

/** The two stages that close a record; the only ones that carry `closedAt`. */
export const TERMINAL_ISSUE_STAGES: readonly IssueStage[] = ["resolved", "dismissed"];

/**
 * Severity is `FindingSeverity`, imported rather than re-declared.
 *
 * Two severity scales that mean almost the same thing is how a `high` in one
 * screen comes to sort below a `critical` in another. `SEVERITY_WEIGHTS` in
 * `data-quality/finding-vocabulary.ts` already prices these three, so a weighted
 * view across both queues is arithmetic rather than a mapping table.
 */
export { FINDING_SEVERITIES as ISSUE_SEVERITIES };
export type IssueSeverity = FindingSeverity;

/**
 * Who moved a record, in the two kinds an actor can be.
 *
 * Deliberately the strings `deal_stage_transitions.actor_kind` already uses, so
 * the two ledgers stay one model. See the table comment below.
 */
export const STAGE_ACTOR_KINDS = ["human", "system"] as const;
export type StageActorKind = (typeof STAGE_ACTOR_KINDS)[number];

export const issueRecords = pgTable(
  "issue_records",
  {
    issueRecordId: text("issue_record_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    recordType: text("record_type").$type<IssueRecordType>().notNull(),

    /** The tenant's own code — a ticket number their support desk already mints. */
    reference: text("reference"),
    /** The record's title field, in the renderer's sense. */
    title: text("title").notNull(),
    details: text("details"),

    severity: text("severity").$type<IssueSeverity>().notNull(),
    stage: text("stage").$type<IssueStage>().notNull().default("open"),

    /**
     * Whose job this is. No foreign key to `users`, ever.
     *
     * `scripts/purge-user.mjs` deletes every row whose column references
     * `users`, ignoring the delete rule, so an owner edge would erase a
     * customer's complaint history the day the person who owned it is
     * offboarded — destroying the record of the failure, not just its owner.
     * See 0223, which removed exactly this edge from two other tables.
     */
    ownerUserId: text("owner_user_id"),

    /**
     * The clock, as four instants rather than one duration.
     *
     * A duration cannot say when the clock started, and a single `dueAt` cannot
     * say whether the first response was late but the fix on time. These four
     * answer "how old is this", "is it late", "did anyone respond" and "when did
     * it stop" without any of them being derived from the others.
     */
    openedAt: timestamp("opened_at").defaultNow().notNull(),
    dueAt: timestamp("due_at"),
    acknowledgedAt: timestamp("acknowledged_at"),
    closedAt: timestamp("closed_at"),

    /**
     * The party this is about. Required for a complaint, allowed on the rest.
     *
     * A complaint from nobody is not a complaint, so the CHECK in 0290 enforces
     * it — while an internal task about a customer is ordinary and stays legal.
     */
    partyId: text("party_id"),

    /**
     * The deal this failure sits against, when there is one.
     *
     * Criterion 2: the commercial consequence of a service failure has to be
     * visible where the commercial decision is made. A complaint filed against a
     * customer with an open renewal is a fact about that renewal, and a pipeline
     * that cannot show it is a pipeline making decisions on partial evidence.
     *
     * Composite tenant key — ("organization_id", "deal_id") against
     * `uniq_deals_org_id` — so a complaint in one organisation cannot reference
     * another organisation's deal and still satisfy referential integrity. The
     * tempting alternative is a single-column key with `ON DELETE SET NULL`, and
     * it is wrong twice over: composite `SET NULL` would null `organization_id`
     * too (0240), and a single-column key would leave tenant safety resting on
     * every caller remembering to validate, which is a bug this programme has
     * now shipped several times.
     *
     * `ON DELETE CASCADE` therefore, and it costs nothing: `deals` is
     * soft-deleted and nothing in `src/` hard-deletes one, so the only path that
     * fires is an organisation being torn down — where removing that
     * organisation's complaints is the correct outcome rather than a loss.
     *
     * `integer`, matching `deals.id`. `activities.deal_id` is `text` against the
     * same column, which is exactly why that table has no foreign key at all.
     */
    dealId: integer("deal_id"),

    /** No foreign key to `users`: see `ownerUserId`. */
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * The list read: one record type, oldest first, with the identifier in the
     * key. The tiebreaker is not decoration — a bulk raiser files many records
     * in the same instant, and a cursor on the timestamp alone would skip some
     * of them and repeat others on every page after the first.
     */
    index("idx_issue_records_type_feed").on(
      t.organizationId,
      t.recordType,
      t.openedAt,
      t.issueRecordId,
    ),
    /** "What is still mine", which is the only question an owner asks daily. */
    index("idx_issue_records_owner")
      .on(t.organizationId, t.ownerUserId, t.stage)
      .where(sql`closed_at is null`),
    /** A party's complaints, read from the party surface. */
    index("idx_issue_records_party")
      .on(t.organizationId, t.partyId)
      .where(sql`party_id is not null`),
    /**
     * The read a deal's own surface makes, and the composite foreign key's own
     * delete-time lookup — which searches on the same pair, so one index serves
     * both and the tenant column still leads.
     */
    index("idx_issue_records_org_deal")
      .on(t.organizationId, t.dealId)
      .where(sql`deal_id is not null`),
    // Per record type, so a tenant's task numbering and their complaint
    // numbering are allowed to collide — they are different sequences.
    uniqueIndex("uniq_issue_records_org_type_reference")
      .on(t.organizationId, t.recordType, t.reference)
      .where(sql`reference is not null`),
    /** The composite tenant key the transition ledger's foreign key points at. */
    unique("uniq_issue_records_org_id").on(t.organizationId, t.issueRecordId),
  ],
);

/**
 * Every move a record made, and what moved it.
 *
 * This is `deal_stage_transitions` column for column, and that is the whole
 * design rather than an accident. Ticket 08 built that ledger because the
 * existing record of a stage change was a `deal_activities` row whose `user_id`
 * was NOT NULL and referenced `users` — so an action the SYSTEM took was not
 * representable, and an autonomous change had nowhere to say it was autonomous.
 * Escalation has the identical problem and the identical remedy, so it gets the
 * identical model: a discriminated actor with a CHECK enforcing it, a reason
 * that survives, and a write in the same transaction as the record's own update.
 *
 * It is a second table rather than rows in the first because
 * `deal_stage_transitions.deal_id` is `integer NOT NULL` with a composite
 * foreign key to `deals`. Putting a complaint there would need either a nullable
 * `deal_id` — destroying the guarantee that every row belongs to a deal — or a
 * fake deal to hang it from. What is shared is the model, not a second one
 * invented alongside it.
 *
 * One thing is deliberately stricter here. The deal ledger permits a `system`
 * row with no `actor_label`, which records that a machine acted and names
 * nothing; 0290's CHECK requires the label. An unattributable autonomous action
 * is the failure the discriminated actor exists to prevent, and allowing half of
 * it back would be a review feed that says "something did this".
 */
export const issueStageTransitions = pgTable(
  "issue_stage_transitions",
  {
    issueStageTransitionId: text("issue_stage_transition_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    issueRecordId: text("issue_record_id").notNull(),

    /** Null on the first transition, where the record had no prior stage. */
    fromStage: text("from_stage").$type<IssueStage>(),
    toStage: text("to_stage").$type<IssueStage>().notNull(),

    /** `human` or `system` — constrained by a CHECK alongside the actor columns. */
    actorKind: text("actor_kind").$type<StageActorKind>().notNull(),
    /** Set when a person moved it; null when the system did. */
    actorUserId: text("actor_user_id"),
    /** What did it, when that was not a person — an automation, a sweep, a model. */
    actorLabel: text("actor_label"),

    reason: text("reason"),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  },
  (t) => [
  foreignKey({ columns: [t.organizationId, t.issueRecordId], foreignColumns: [issueRecords.organizationId, issueRecords.issueRecordId], name: "fk_issue_stage_transitions_record" }).onDelete("cascade"),
    // One record's history, newest first.
    index("idx_issue_stage_transitions_record").on(
      t.organizationId,
      t.issueRecordId,
      t.occurredAt,
    ),
    // And the review feed's read: everything the system did, newest first.
    index("idx_issue_stage_transitions_actor").on(t.organizationId, t.actorKind, t.occurredAt),
  ],
);
