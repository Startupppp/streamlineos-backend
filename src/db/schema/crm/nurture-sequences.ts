import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * A nurture sequence, stored as a cadence and nothing else.
 *
 * The single decision this file encodes is what a step is NOT. It is not a
 * message: there is no subject column, no body column and no recipient column
 * anywhere below. A step says only "consider writing to this person again, this
 * long after the last one" — and the considering is `OutboundService.
 * composeAndHold`, which judges eligibility, drafts, applies its confidence
 * threshold, places a hold and lets `outbound.workflow.ts` take the late
 * guardrail snapshot at the far end of the window.
 *
 * That is why these tables exist beside `crm_sequences` rather than as columns
 * on it. `crm_sequence_steps.config` carries a literal `to`, `subject` and
 * `body`, and `crm-sequences-runner.service.ts` hands them straight to
 * `CrmOutboundEmailService.send` — no hold, no guardrails, no cold gate, no row
 * in the decision ledger. There is nowhere in `composeAndHold` for a pre-written
 * body to go, so the two engines disagree about what a step IS, and the older
 * one additionally logs `stopOn.replied` as an unsupported key. Retrofitting
 * would silently change the behaviour of every enrolment already in flight.
 * See `nurture-cadence.ts` for the rest of that argument.
 *
 * Every table here is tenant-scoped and every one of them carries
 * `organization_id` — including the child tables, which could have reached it
 * through their parent. They carry it because RLS is per table: a policy on the
 * parent protects nothing about a query that starts at the child.
 */

export const NURTURE_SEQUENCE_STATUSES = ["draft", "active", "paused"] as const;
export type NurtureSequenceStatus = (typeof NURTURE_SEQUENCE_STATUSES)[number];

export const NURTURE_ENROLLMENT_STATUSES = ["active", "completed", "exited", "failed"] as const;
export type NurtureEnrollmentStatus = (typeof NURTURE_ENROLLMENT_STATUSES)[number];

export const crmNurtureSequences = pgTable(
  "crm_nurture_sequences",
  {
    nurtureSequenceId: text("nurture_sequence_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    name: text("name").notNull(),
    description: text("description"),

    /**
     * `draft` · `active` · `paused`.
     *
     * A run wakes days after it was scheduled and re-reads this, so pausing a
     * sequence stops the enrolments already inside it rather than only refusing
     * new ones. Stopping the ones already decided is the half that matters —
     * see `AutonomyHoldService.cancelInFlight`, which exists for the same
     * reason on the kill switch.
     */
    status: text("status").$type<NurtureSequenceStatus>().default("draft").notNull(),

    createdByUserId: text("created_by_user_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * One live sequence per name per tenant, case-insensitively.
     *
     * Two sequences called "Post-demo" is how somebody enrols a customer in the
     * wrong one and cannot tell from the list which they picked. Partial on
     * `deleted_at IS NULL` so a deleted name is reusable.
     */
    uniqueIndex("uniq_crm_nurture_sequences_name")
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`deleted_at is null`),

    index("idx_crm_nurture_sequences_org").on(t.organizationId, t.status, t.createdAt),
  ],
);

export const crmNurtureSequenceSteps = pgTable(
  "crm_nurture_sequence_steps",
  {
    nurtureStepId: text("nurture_step_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    nurtureSequenceId: text("nurture_sequence_id").notNull(),

    /** 1-based, and dense. `stepNumbersAreDense` in `nurture-cadence.ts` says why. */
    stepNumber: integer("step_number").notNull(),

    /**
     * How long after the previous step — or after enrolment, for step 1 — this
     * one is considered.
     *
     * Floored at `MIN_STEP_WAIT_HOURS`, which is derived from
     * `PARTY_FREQUENCY_CAPS` rather than chosen. A cadence tighter than the cap
     * schedules sends `evaluateGuardrails` is guaranteed to refuse: the tenant
     * pays for a draft per step, the sequence reports itself as running, and
     * nothing leaves.
     */
    waitHours: integer("wait_hours").notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_crm_nurture_sequence_steps_number").on(t.nurtureSequenceId, t.stepNumber),
    index("idx_crm_nurture_sequence_steps_seq").on(
      t.organizationId,
      t.nurtureSequenceId,
      t.stepNumber,
    ),
  ],
);

export const crmNurtureEnrollments = pgTable(
  "crm_nurture_enrollments",
  {
    nurtureEnrollmentId: text("nurture_enrollment_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    nurtureSequenceId: text("nurture_sequence_id").notNull(),

    /**
     * A party, matching `crm_outbound_messages.party_id`.
     *
     * Not the `(entity_type, entity_id)` pair `crm_sequence_enrollments` uses.
     * The frequency cap, the class stops and the suppression check are all keyed
     * on the party, and an enrolment keyed on anything else cannot be compared
     * against them without a mapping that does not totally exist.
     */
    partyId: text("party_id").notNull(),
    /**
     * The deal it is about, carried through to `composeAndHold`.
     *
     * Integer with a foreign key, like `activities.deal_id` and
     * `relationship_states.deal_id` after 0472 and 0557 — `deals.id` is a
     * `serial`, and a text column against it can carry no key and forces an
     * implicit cast on every join. `ON DELETE SET NULL` rather than cascade: an
     * enrolment is a conversation with a person and outlives the deal it was
     * about.
     */
    dealId: integer("deal_id"),

    status: text("status").$type<NurtureEnrollmentStatus>().default("active").notNull(),
    /** How many steps have been attempted. 0 means none yet; step 1 is next. */
    currentStep: integer("current_step").default(0).notNull(),

    /**
     * In the vocabulary of `NURTURE_EXIT_REASONS`. `replied` is the one the
     * whole feature is judged on.
     */
    exitReason: text("exit_reason"),
    exitedAt: timestamp("exited_at"),

    /** The durable run driving it. Null only between the insert and `startRun`. */
    workflowRunId: text("workflow_run_id"),

    enrolledAt: timestamp("enrolled_at").defaultNow().notNull(),
    enrolledByUserId: text("enrolled_by_user_id"),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * ONE live enrolment per party, across every sequence in the tenant.
     *
     * Not per sequence. Two sequences nurturing the same customer at once is
     * precisely the "talking over them" failure this ticket exists to prevent,
     * and each one would be able to show that it behaved — the same argument
     * `PARTY_FREQUENCY_CAPS` makes about four loops each politely sending one.
     * The frequency cap would blunt it at send time; this refuses it at
     * enrolment, where a person can be told.
     */
    uniqueIndex("uniq_crm_nurture_enrollments_live_party")
      .on(t.organizationId, t.partyId)
      .where(sql`status = 'active'`),

    /**
     * The exit-on-reply read, and the shape it is issued in.
     *
     * `SequenceReplyExitService` runs on the inbound path for every delivered
     * reply, so it is on the hot path of ingest rather than of a background
     * sweep. Organisation then party then status is the order it filters in.
     */
    index("idx_crm_nurture_enrollments_party")
      .on(t.organizationId, t.partyId, t.status)
      .where(sql`status = 'active'`),

    index("idx_crm_nurture_enrollments_sequence").on(
      t.organizationId,
      t.nurtureSequenceId,
      t.enrolledAt,
    ),
  ],
);

/**
 * What one step actually produced, including when it produced nothing.
 *
 * A step whose `composeAndHold` refused on eligibility, on confidence or on the
 * kill switch writes a row here saying so. Recording only the successes would
 * make a sequence that has been refusing every step for a fortnight
 * indistinguishable from one that is patiently waiting — and the person looking
 * at it needs to tell those apart.
 */
export const crmNurtureStepAttempts = pgTable(
  "crm_nurture_step_attempts",
  {
    nurtureStepAttemptId: text("nurture_step_attempt_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    nurtureEnrollmentId: text("nurture_enrollment_id").notNull(),

    stepNumber: integer("step_number").notNull(),

    /** `held` when a hold was placed, `refused` when `composeAndHold` declined. */
    outcome: text("outcome").notNull(),
    /** `composeAndHold`'s own words, so the feed does not have to reword them. */
    reason: text("reason"),

    /** Set only on `held`; this is the join back into the outbound loop. */
    outboundMessageId: text("outbound_message_id"),
    autonomyHoldId: text("autonomy_hold_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /**
     * At most one attempt per step per enrolment.
     *
     * The workflow's step memo already makes the attempt at-most-once on the
     * happy path, but a memo lives in `workflow_steps` and a run whose steps
     * were pruned would re-attempt. This is the constraint that means a second
     * attempt is a 23505 rather than a second message to the same customer.
     */
    uniqueIndex("uniq_crm_nurture_step_attempts_step").on(t.nurtureEnrollmentId, t.stepNumber),
    index("idx_crm_nurture_step_attempts_org").on(t.organizationId, t.createdAt),
  ],
);
