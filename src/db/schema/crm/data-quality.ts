import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  doublePrecision,
  integer,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import type { ReversibilityClass } from "./autonomous-decisions";

/**
 * The queue every data-quality producer writes into, and the ledger of what a
 * person decided about it.
 *
 * Phase 1 already detects duplicates and files the pairs in
 * `party_duplicate_candidates`. Nobody owns those rows, nobody is measured on
 * them, and nothing records what happened to one — which makes the detector a
 * report rather than work. This is the queue that turns a finding into
 * somebody's job: it carries an assignee, an age that survives re-detection, the
 * action the system would take, and the reversibility of that action.
 *
 * The vocabulary is deliberately the decision record's. `reversibility` is
 * literally `REVERSIBILITY_CLASSES` from `autonomous-decisions`, not a parallel
 * set that means almost the same thing, so the review feed and this queue read
 * alike and a person moving between them is not learning two dialects.
 */

/**
 * What noticed the problem.
 *
 * A producer is a *class of evidence*, not a check — several checks can share
 * one, and the queue groups by it because "the duplicate detector is noisy" and
 * "our contact data is unreachable" are different conversations with different
 * owners.
 */
export const DATA_QUALITY_PRODUCERS = [
  /** Two records that appear to describe the same organisation. */
  "duplicate",
  /** Two records that share an identifier and disagree on a stronger one. */
  "contradiction",
  /** A party nothing can reach: suppressed, malformed, or no channel at all. */
  "reachability",
  /** A party nobody has touched for long enough that its data is suspect. */
  "staleness",
  /**
   * Rows an import could not resolve confidently.
   *
   * Written by `crm-import` since ticket 13: a row whose best existing match
   * scores between the review and auto-merge thresholds is not written at all,
   * and files one of these instead. It stays out of `SWEEPABLE_PRODUCERS`
   * because a sweep re-derives its findings from the current state of the
   * database and there is nothing here to re-derive from — the uncertainty
   * existed for the duration of one import and is only knowable from the plan
   * that recorded it.
   */
  "import-uncertainty",
] as const;
export type DataQualityProducer = (typeof DATA_QUALITY_PRODUCERS)[number];

/**
 * How much a finding costs while it stays open.
 *
 * The dataset-health number is the open queue weighted by this, so severity is
 * the only thing that stops "four hundred stale leads" outranking "two customers
 * with contradictory tax numbers".
 */
export const FINDING_SEVERITIES = ["high", "medium", "low"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * `dismissed` and `resolved` are both terminal and deliberately distinct: one
 * says the finding was wrong, the other says it was right and has been dealt
 * with. Collapsing them would make the detector's own accuracy unmeasurable.
 */
export const FINDING_STATUSES = ["open", "resolved", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * What the system would do if a human said yes.
 *
 * Constrained rather than free text because every value here needs an executor
 * and a reversibility class, and a value with neither is a promise the queue
 * cannot keep. `none` is honest: plenty of findings have no safe automatic
 * remedy and exist so a person looks at the record.
 */
export const PROPOSED_ACTIONS = ["merge-parties", "none"] as const;
export type ProposedAction = (typeof PROPOSED_ACTIONS)[number];

/** What a person did about a selection of findings. */
export const RESOLUTION_ACTIONS = ["apply", "dismiss"] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

/** How a decision named the findings it covers — an explicit list, or a group. */
export const SELECTION_KINDS = ["ids", "group"] as const;
export type SelectionKind = (typeof SELECTION_KINDS)[number];

/**
 * One decision, however many findings it covered.
 *
 * This is the row that makes bulk resolution first-class rather than a loop.
 * Four hundred parties with the same malformed number is one row here and four
 * hundred pointers to it — so it is reviewed once, counted once, and undone
 * once. A per-item ledger would make "who decided this" a four-hundred-way
 * answer to a one-way question.
 *
 * `reversibility` is the *strictest* class among the findings the decision
 * applied, because a batch is only as reversible as its least reversible member.
 */
export const dataQualityResolutions = pgTable(
  "data_quality_resolutions",
  {
    resolutionId: text("resolution_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    action: text("action").$type<ResolutionAction>().notNull(),
    selectionKind: text("selection_kind").$type<SelectionKind>().notNull(),
    /** Set when the decision named a group rather than a list of identifiers. */
    groupKey: text("group_key"),

    reversibility: text("reversibility").$type<ReversibilityClass>().notNull(),
    /**
     * When a `hold` stops being reversible.
     *
     * Only ever set for `hold`; `instant` needs no deadline and `irreversible`
     * would be lying about one.
     */
    holdUntil: timestamp("hold_until"),

    reason: text("reason"),

    /**
     * Three counts, not one.
     *
     * `attempted` is what the human selected, `resolved` is what actually moved,
     * and the gap is the interesting part: an item somebody else resolved a
     * second earlier, or one whose remediation failed. Reporting only the
     * success count would make a half-applied bulk decision look complete.
     */
    attemptedCount: integer("attempted_count").notNull(),
    resolvedCount: integer("resolved_count").notNull(),
    failedCount: integer("failed_count").notNull().default(0),
    /**
     * Which ones failed and why, capped by the caller.
     *
     * Evidence for a person, in the same spirit as `autonomous_decisions.inputs`
     * — not a lifecycle list. The failed findings themselves stay `open` in the
     * queue carrying their own `last_error`, which is where they are worked.
     */
    failures: jsonb("failures").$type<{ findingId: string; error: string }[]>(),

    /** No foreign key to `users`: see 0223. A decision outlives its decider. */
    decidedByUserId: text("decided_by_user_id").notNull(),
    decidedAt: timestamp("decided_at").defaultNow().notNull(),

    reversedAt: timestamp("reversed_at"),
    reversedByUserId: text("reversed_by_user_id"),
    reversedReason: text("reversed_reason"),
    reversedCount: integer("reversed_count"),
  },
  (t) => [
    // The ledger, newest first, with the identifier as the keyset tiebreaker.
    index("idx_data_quality_resolutions_feed").on(t.organizationId, t.decidedAt, t.resolutionId),
    // What is still undoable, for the surface that offers the undo.
    index("idx_data_quality_resolutions_open")
      .on(t.organizationId, t.decidedAt)
      .where(sql`reversed_at is null`),
    /** The composite tenant key the findings' foreign key points at. */
    unique("uniq_data_quality_resolutions_org_id").on(t.organizationId, t.resolutionId),
  ],
);

/**
 * One thing wrong with the dataset, and whose job it is.
 *
 * `firstDetectedAt` is set once and never touched again. That is the whole point
 * of the age column: a sweep that re-detects the same problem every night would
 * otherwise reset it, and a queue where nothing ever ages is a queue nobody is
 * accountable for.
 *
 * `groupKey` is what makes bulk resolution possible without a human picking four
 * hundred checkboxes. Producers set it to the *shape* of the problem — the
 * blocker text, the suppression reason, the staleness band — so the queue can
 * offer "these 412 findings, one decision" as a single row.
 */
export const dataQualityFindings = pgTable(
  "data_quality_findings",
  {
    findingId: text("finding_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    producer: text("producer").$type<DataQualityProducer>().notNull(),
    /** The producer's own finer label, `producer.detail` by convention. */
    findingKind: text("finding_kind").notNull(),
    /**
     * What this finding is *about*, in a form a producer can recompute.
     *
     * The dedupe key, so a second sweep updates the finding instead of filing a
     * copy. For a pair it is the ordered pair; for a single record and field it
     * is the record and the field.
     */
    subjectKey: text("subject_key").notNull(),
    /** The shape of the problem — the axis bulk resolution slices on. */
    groupKey: text("group_key").notNull(),

    severity: text("severity").$type<FindingSeverity>().notNull(),
    status: text("status").$type<FindingStatus>().notNull().default("open"),

    /**
     * The record, and the second record where the finding is about a pair.
     *
     * Explicit columns rather than an `entity_type`/`entity_id` pair, which is
     * banned for new tables: no referential integrity and no composite tenant
     * key. Every producer wired today is party-shaped; a finding about something
     * else gets its own column and a widened CHECK, the way `autonomy_holds`
     * treats `quote_id`.
     */
    partyId: text("party_id").notNull(),
    relatedPartyId: text("related_party_id"),

    /** What the producer saw, enough for a person to judge it without re-running. */
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    /** The detector's number, where the producer has one. */
    score: doublePrecision("score"),

    proposedAction: text("proposed_action").$type<ProposedAction>().notNull(),
    /** The action's payload, in the shape its executor expects. */
    proposedPatch: jsonb("proposed_patch").$type<Record<string, unknown>>(),
    reversibility: text("reversibility").$type<ReversibilityClass>().notNull(),

    /** Plain text, never a foreign key to `users`: see 0223. */
    assignedToUserId: text("assigned_to_user_id"),
    assignedByUserId: text("assigned_by_user_id"),
    assignedAt: timestamp("assigned_at"),

    /** Set once, at first detection. Re-detection updates `lastSeenAt` instead. */
    firstDetectedAt: timestamp("first_detected_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),

    resolvedAt: timestamp("resolved_at"),
    resolvedByUserId: text("resolved_by_user_id"),
    /** The one decision that closed this, and the one that can undo it. */
    resolutionId: text("resolution_id"),
    /**
     * What an undo needs, captured at the moment the action succeeded.
     *
     * A merge leaves a `party_merge_id`; reconstructing it later from the
     * records' current state cannot tell a field the merge filled from one a
     * person edited afterwards, which is the same reasoning
     * `party-merge.service` records its snapshot for.
     */
    undoToken: jsonb("undo_token").$type<Record<string, unknown>>(),

    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [
    /**
     * One open finding per problem. Partial on `open` so a recurrence after a
     * resolution files a new finding rather than resurrecting a closed one —
     * which would lose the record that somebody already dealt with it once.
     */
    uniqueIndex("uniq_data_quality_findings_open")
      .on(t.organizationId, t.producer, t.findingKind, t.subjectKey)
      .where(sql`status = 'open'`),
    /**
     * The queue itself: oldest first, because age is the point. The identifier
     * trails the sort column so the keyset has a total order — without it two
     * findings detected in the same sweep share a timestamp and pages skip and
     * repeat rows.
     */
    index("idx_data_quality_findings_queue").on(
      t.organizationId,
      t.status,
      t.firstDetectedAt,
      t.findingId,
    ),
    /** "What is mine", and "what is nobody's". */
    index("idx_data_quality_findings_assignee")
      .on(t.organizationId, t.assignedToUserId, t.firstDetectedAt)
      .where(sql`status = 'open'`),
    /** The grouped view, and the predicate a group-shaped bulk decision claims on. */
    index("idx_data_quality_findings_group").on(
      t.organizationId,
      t.groupKey,
      t.status,
      t.findingId,
    ),
    /** Everything open against one record, for the record's own screen. */
    index("idx_data_quality_findings_party").on(t.organizationId, t.partyId, t.status),
    /** What one decision covered — the undo's own read. */
    index("idx_data_quality_findings_resolution").on(t.organizationId, t.resolutionId),
    /**
     * "Is the dataset getting better or worse" is opened-in-window against
     * closed-in-window, and the closed half has no other indexed path to it.
     */
    index("idx_data_quality_findings_closed")
      .on(t.organizationId, t.resolvedAt)
      .where(sql`resolved_at is not null`),
    unique("uniq_data_quality_findings_org_id").on(t.organizationId, t.findingId),
  ],
);
