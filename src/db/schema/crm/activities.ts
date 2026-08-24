import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";

/**
 * One thing that happened, whatever kind of thing it was.
 *
 * The CRM currently records a call five different ways depending on which module
 * the record entered through — `deal_activities` for a deal, `lead_activities`
 * plus `lead_emails` for a lead, `tasks` for the Activities page,
 * `client_account_activities` for an account, and `crm_activities` for the
 * dashboard. So no screen can honestly claim to show everything about a
 * customer, which is the second problem the PRD opens with.
 *
 * This is the single model. It does NOT migrate the five that exist — the PRD
 * puts downstream consumers explicitly out of scope for phase 1 — it is the
 * go-forward store that ticket 10's ingress writes into and that the timeline
 * reads from.
 */

/** Everything a timeline shows. Kept small: a kind nothing renders is dead data. */
export const ACTIVITY_KINDS = ["call", "email", "meeting", "note", "task"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Whether the record shows something a person did or something the system did.
 *
 * The PRD requires a reader to see plainly which is which, and the only way that
 * survives is if it is a column rather than a convention about who was logged in.
 */
export const ACTIVITY_ACTOR_KINDS = ["human", "system"] as const;
export type ActivityActorKind = (typeof ACTIVITY_ACTOR_KINDS)[number];

export const activities = pgTable(
  "activities",
  {
    activityId: text("activity_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").$type<ActivityKind>().notNull(),

    /**
     * When it happened, which is not when the row was written.
     *
     * An email ingested an hour late belongs where it happened on the timeline,
     * not at the top of it.
     */
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),

    subject: text("subject"),
    body: text("body"),

    /**
     * What ties a reply to the message it answers.
     *
     * Provider-supplied where there is one (an RFC 5322 thread), otherwise
     * synthesised at the ingress seam. Opaque here on purpose: nothing below the
     * seam should know which provider produced it.
     */
    threadId: text("thread_id"),

    /** The records this belongs to. A timeline is read by one of these three. */
    partyId: text("party_id"),
    dealId: text("deal_id"),
    subjectId: text("subject_id"),

    /** `human` or `system` — constrained by a CHECK alongside the actor column. */
    actorKind: text("actor_kind").$type<ActivityActorKind>().notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** What did it, when that was not a person — an adapter, a model version. */
    actorLabel: text("actor_label"),

    /** Set on a task; null on everything else. */
    dueAt: timestamp("due_at"),
    completedAt: timestamp("completed_at"),
    assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),

    /**
     * Where it came from — `manual`, or the adapter that produced it.
     *
     * Distinct from `actorKind`: a person can send an email that arrives through
     * an adapter, and both facts matter to a reviewer.
     */
    source: text("source").default("manual").notNull(),

    /** Provider-specific remainder. Never read for a lifecycle decision. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),

    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * The timeline reads, one per anchor.
     *
     * Keyset-ordered on (occurred_at, activity_id) because a cursor needs a
     * total order and timestamps collide — an import of a mail folder writes
     * hundreds in the same second.
     */
    index("idx_activities_party_timeline")
      .on(t.organizationId, t.partyId, t.occurredAt, t.activityId)
      .where(sql`deleted_at is null`),
    index("idx_activities_deal_timeline")
      .on(t.organizationId, t.dealId, t.occurredAt, t.activityId)
      .where(sql`deleted_at is null`),
    index("idx_activities_subject_timeline")
      .on(t.organizationId, t.subjectId, t.occurredAt, t.activityId)
      .where(sql`deleted_at is null`),

    /** A person's own open tasks, which is a different read from a timeline. */
    index("idx_activities_assignee_open")
      .on(t.organizationId, t.assigneeUserId, t.dueAt)
      .where(sql`kind = 'task' and completed_at is null and deleted_at is null`),

    /** A thread, gathered. */
    index("idx_activities_thread").on(t.organizationId, t.threadId),

    /** The tenant key a participant's composite foreign key points at. */
    uniqueIndex("uniq_activities_org_id").on(t.organizationId, t.activityId),
  ],
);

/**
 * Who was on it.
 *
 * A link table rather than a JSONB array, because a participant is a lifecycle
 * entity — you filter by it, count it, and resolve it to a party — and because
 * an array cannot be indexed or joined. One row per person per activity.
 */
export const activityParticipants = pgTable(
  "activity_participants",
  {
    activityParticipantId: text("activity_participant_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    activityId: text("activity_id").notNull(),

    /**
     * Exactly one of these identifies the participant, enforced by a CHECK.
     *
     * An external participant resolves to a party; an internal one to a user;
     * an unresolved inbound address has neither yet and keeps only its address,
     * which is what lets the ingress seam record a message from someone the CRM
     * has never seen.
     */
    partyId: text("party_id"),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    address: text("address"),

    /** `from` · `to` · `cc` · `attendee` · `organiser`. */
    role: text("role").default("attendee").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_activity_participants_activity").on(t.organizationId, t.activityId),
    // The reverse read: everything this party was on.
    index("idx_activity_participants_party").on(t.organizationId, t.partyId, t.activityId),
  ],
);
