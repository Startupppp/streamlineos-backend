import { randomUUID } from "node:crypto";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * What one completed call was, worked out once and never again.
 *
 * The row is keyed on the SHA-256 of the transcript rather than on the call,
 * and that is the whole design rather than an optimisation. A transcript is
 * delivered more than once in practice — a carrier replay, an operator
 * re-running an import, the same recording filed against a party and again
 * against the deal — and each delivery produces a distinct `activities` row
 * through the ingress seam. Keying on the activity would spend a model call per
 * copy and, worse, return a *different* answer for each: the same transcript
 * analysed twice by a language model does not come back the same. Keying on the
 * transcript makes "re-analyse this call" free and makes the second answer
 * identical to the first by construction.
 *
 * Scoped to the organisation even though a hash is tenant-neutral. Two tenants
 * holding a byte-identical sales transcript is not a real event, and the row
 * carries verbatim quotes out of the call — so a shared cache would trade a
 * saving nobody will ever collect for a cross-tenant disclosure of what a
 * customer said. Every read in `CallAnalysisService` carries the organisation
 * predicate and the RLS policy in `0540` carries it again.
 *
 * `analyzer_version` is in the key beside the hash, and it is the one thing
 * that lets a cached answer be superseded. The cache promise is "the same
 * transcript costs nothing and reads the same" — but only for a given analyser.
 * Without this column, editing the prompt or widening the contract would leave
 * every previously analysed call serving output from a prompt that no longer
 * exists, invisibly and forever. Bumping `CALL_ANALYSIS_ANALYZER_VERSION`
 * re-opens exactly the calls somebody chooses to re-open.
 */

/** How a rep dealt with something the customer pushed back on. */
export const OBJECTION_HANDLINGS = [
  "answered",
  "acknowledged",
  "deflected",
  "unaddressed",
] as const;
export type ObjectionHandling = (typeof OBJECTION_HANDLINGS)[number];

/**
 * One objection, in the customer's own words.
 *
 * `quote` is verbatim rather than a paraphrase because the row exists to be
 * read by a sales manager who was not on the call, and a paraphrased objection
 * is a claim about what a customer meant with nothing behind it. `response` is
 * the rep's reply, and is null exactly when `handling` is `unaddressed` — there
 * is no reply to quote when nobody answered.
 */
export interface CallObjection {
  readonly quote: string;
  readonly handling: ObjectionHandling;
  readonly response: string | null;
}

/** A rival named on the call, and the line that named them. */
export interface CompetitorMention {
  readonly name: string;
  readonly quote: string;
}

export const callAnalyses = pgTable(
  "crm_call_analyses",
  {
    callAnalysisId: text("call_analysis_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /** Lowercase hex SHA-256 of the normalised transcript. The cache key. */
    transcriptHash: text("transcript_hash").notNull(),
    /** `CALL_ANALYSIS_ANALYZER_VERSION` at the time the row was written. */
    analyzerVersion: integer("analyzer_version").notNull(),

    /**
     * The call this analysis was first produced for.
     *
     * Provenance, not identity. A second activity carrying the same transcript
     * reads this row and does not rewrite this column — repointing it would
     * make the cached answer look like it came from whichever copy asked most
     * recently, which is a worse lie than a stale pointer.
     *
     * Deliberately not a foreign key to `activities`: an analysis is a record
     * of what was said, and deleting the timeline entry must not silently
     * delete the reason a deal was called at risk. The organisation edge below
     * is the only cascade this row is on.
     */
    activityId: text("activity_id").notNull(),

    /**
     * The rep's share of the words, in basis points. Integer, never a float:
     * 3333 is a third, and nothing downstream has to agree on rounding.
     *
     * Null when the transcript is not speaker-attributed, or when the model
     * could not say which speaker was ours. A missing talk ratio is not fifty
     * percent — see `transcript-metrics.ts`, which refuses rather than splits.
     */
    talkRatioBps: integer("talk_ratio_bps"),

    /**
     * The counts the question rate is computed from, stored instead of the
     * rate. A rate is a division and a division stored is a number nobody can
     * check; `4 questions across 11 turns` can be re-derived, re-banded and
     * summed across calls, and `3636 bps` cannot.
     */
    repTurnCount: integer("rep_turn_count"),
    repQuestionCount: integer("rep_question_count"),

    objections: jsonb("objections").$type<CallObjection[]>().notNull(),
    competitorMentions: jsonb("competitor_mentions")
      .$type<CompetitorMention[]>()
      .notNull(),

    /**
     * Whether anybody agreed to do anything next.
     *
     * The single most useful bit on the row, and the reason it is a boolean
     * beside the text rather than "the text is non-empty": a call with no next
     * step is the thing a manager filters for, and filtering on emptiness makes
     * that query depend on whether the model wrote "none" or "".
     */
    nextStepCommitted: boolean("next_step_committed").notNull(),
    nextStep: text("next_step"),

    /** The model that produced it, so a bad batch can be found by its author. */
    model: text("model"),
    promptKey: text("prompt_key").notNull(),
    promptVersion: integer("prompt_version").notNull(),

    /** How much text was actually judged, after the cap. */
    transcriptChars: integer("transcript_chars").notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * The cache lookup, and the constraint that makes the cache a cache.
     *
     * Without the unique index two concurrent analyses of the same transcript
     * both insert and the second read gets whichever row the planner reaches
     * first — two paid model calls and a coin flip over which answer a customer
     * record shows. The service inserts `ON CONFLICT DO NOTHING` and re-reads,
     * so the loser of the race spends its call and then agrees with the winner.
     */
    uniqueIndex("uniq_crm_call_analyses_hash").on(
      t.organizationId,
      t.transcriptHash,
      t.analyzerVersion,
    ),

    /** The read the call surface makes: this activity, latest analyser first. */
    index("idx_crm_call_analyses_activity").on(
      t.organizationId,
      t.activityId,
      t.analyzerVersion,
    ),
  ],
);

/**
 * The rep saying "you can read this now", ahead of the window.
 *
 * A separate table rather than a column on `crm_call_analyses`, and the reason
 * is the key on that table. An analysis row is keyed on the transcript, so one
 * row can be the analysis of several `activities` rows — a carrier replay, a
 * re-import, one recording filed against both a party and a deal. Consent is not
 * a property of a transcript; it is one person deciding about one of their
 * calls. A `released_at` column on the shared row would let a rep who released
 * their copy release a colleague's copy of the same conversation, silently.
 *
 * `analyzer_version` is in the key beside the activity, and that is the whole
 * point of storing it here. A release is consent to the text the rep actually
 * read. Bumping `CALL_ANALYSIS_ANALYZER_VERSION` produces a different judgement
 * of the same call — different objections, possibly a different verdict on
 * whether a next step was committed — and carrying the old consent forward would
 * publish a paragraph about somebody that they never saw and never agreed to.
 * A new analyser version re-closes the window; the rep releases again or waits.
 *
 * Nothing here records a *withdrawal*. That is deliberate and not an oversight:
 * once a manager has read the analysis, un-sharing it does not unread it, and an
 * "unshare" control would promise a retraction the system cannot perform. The
 * window expiring is the only other way this opens, and it opens for everyone.
 */
export const callAnalysisReleases = pgTable(
  "crm_call_analysis_releases",
  {
    callAnalysisReleaseId: text("call_analysis_release_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The call whose analysis was released — the `activities` row, not the
     * analysis row. See the docblock above for why consent is per call.
     *
     * Deliberately not a foreign key to `activities`, for the same reason
     * `crm_call_analyses.activity_id` is not one: `scripts/purge-user.mjs` and a
     * timeline delete must not be able to quietly revoke a decision a person
     * made. The organisation edge is the only cascade this row is on.
     */
    activityId: text("activity_id").notNull(),

    /** The analyser whose output was released. A bump re-closes the window. */
    analyzerVersion: integer("analyzer_version").notNull(),

    /**
     * The rep who released it. Not a foreign key to `users` — the house rule on
     * every actor column in this schema, stated at length on
     * `activities.actorUserId`: offboarding a rep must not erase the record of
     * a decision they made about their own call.
     */
    releasedByUserId: text("released_by_user_id").notNull(),

    /**
     * What the rep wanted said alongside it, if anything.
     *
     * Optional, and here rather than in a comment thread because sharing early
     * is an act of communication — "the pricing objection at the end is the one
     * I want help with" — and a release with nowhere to put that is a switch,
     * which is the surveillance reading of the same feature.
     */
    note: text("note"),

    releasedAt: timestamp("released_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /**
     * One release per call per analyser. Without the unique index a rep tapping
     * "share" twice writes two rows, and the policy would then have to decide
     * which `released_at` is the real one — a question with no right answer that
     * only exists because the table let it be asked.
     */
    uniqueIndex("uniq_crm_call_analysis_releases").on(
      t.organizationId,
      t.activityId,
      t.analyzerVersion,
    ),
  ],
);

/**
 * Where a call happened, and who agreed to it being recorded.
 *
 * Phase 5 ticket 03. Two-party consent jurisdictions are a criminal-law
 * constraint, so the evidence they require has to be a record somebody made
 * rather than something the system infers. Two things could have been inferred
 * and deliberately are not.
 *
 * `jurisdiction` is not derived from the counterparty's phone number. An area
 * code says where a number was issued, not where its holder was sitting when
 * they answered it, and a mobile number carries its issuing region across
 * borders for life. Nor is it read from `activities.metadata` — that column's
 * own docblock says it is never read for a lifecycle decision, and whether a
 * call may lawfully be analysed is the most lifecycle-shaped decision in this
 * module.
 *
 * The counterparty's agreement is not stored here when it is a standing PHONE
 * opt-in. That already lives in `crm_contact_channel_consent` with its own
 * append-only event history, and copying it would create a second answer to
 * "has this person opted out?" that drifts the moment somebody unsubscribes.
 * `CallRecordingConsentService` reads the standing record and this table
 * together. What this table holds about the counterparty is the per-call form of
 * consent that has nowhere else to live: the recording notice played at the top
 * of the call and acknowledged, or a signed clause.
 *
 * One row per call, not per party. A call in this model has two sides — the
 * organisation and the customer — and one row keyed on the activity is what
 * makes "is there evidence for this call" a single lookup rather than a fold
 * over rows whose absence is indistinguishable from a missing join.
 */
export const callRecordingConsent = pgTable(
  "crm_call_recording_consent",
  {
    callRecordingConsentId: text("call_recording_consent_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The call. Deliberately not a foreign key to `activities`, the same choice
     * `crm_call_analyses.activity_id` and `crm_call_analysis_releases.activity_id`
     * make: a timeline delete must not erase the evidence that a recording was
     * lawful. That evidence is the organisation's defence, and it has to outlive
     * the row that prompted it.
     */
    activityId: text("activity_id").notNull(),

    /**
     * ISO 3166-1 alpha-2, optionally with an ISO 3166-2 subdivision — `DE`,
     * `US-CA`. Normalised by `normaliseJurisdiction` before it is written, and
     * constrained by a CHECK, because an unconstrained string that matches no
     * register entry silently resolves to all-party: the right answer arrived at
     * by accident, which stops being right the day somebody adds a fuzzy lookup.
     */
    jurisdiction: text("jurisdiction").notNull(),

    /**
     * When our side agreed. Usually the rep's own act of recording, which is why
     * `own-recording` is a method — but it is written rather than assumed, so an
     * adapter-delivered call with nobody attributed has no row here and is
     * refused rather than waved through.
     */
    orgPartyConsentedAt: timestamp("org_party_consented_at"),
    orgPartyMethod: text("org_party_method"),

    /**
     * The per-call form of the customer's agreement — the notice acknowledged on
     * the call, or a signed clause. Null when the only evidence is the standing
     * PHONE opt-in, which is read from `crm_contact_channel_consent` instead.
     */
    counterpartyConsentedAt: timestamp("counterparty_consented_at"),
    counterpartyMethod: text("counterparty_method"),

    /**
     * They asked, on this call, that it not be processed. Distinct from a
     * channel-wide opt-out: somebody can be happy to be phoned and unhappy to be
     * recorded, and collapsing the two would either over-block every future call
     * or lose this one.
     */
    counterpartyWithdrawnAt: timestamp("counterparty_withdrawn_at"),

    /** What the attester wants a later reviewer to know. Bounded to a sentence. */
    note: text("note"),

    /**
     * Who attested. No foreign key to `users`, the house rule on every actor
     * column in this schema (see `activities.actorUserId`): offboarding somebody
     * must not delete the compliance record they signed.
     */
    attestedByUserId: text("attested_by_user_id").notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * One attestation per call. Two rows would make "where did this happen" a
     * question with two answers, and the rule would then be deciding which
     * evidence to believe — a question no correct answer exists for and which
     * only exists because the table allowed it to be asked. The service upserts
     * onto exactly this pair.
     */
    uniqueIndex("uniq_crm_call_recording_consent").on(t.organizationId, t.activityId),
  ],
);

/**
 * Every call the consent rule refused, so the gap is visible.
 *
 * Without this table a refusal is indistinguishable from a call nobody thought
 * to analyse. Both render as an empty analysis panel, and a team whose
 * jurisdiction field is never filled in would conclude the feature does not work
 * rather than that they are missing a compliance record. The ledger is how "we
 * are refusing 340 calls a month for want of a jurisdiction" becomes something
 * somebody can see and fix.
 *
 * It carries no transcript, no quote, and no analysis — the refusal exists
 * precisely because none of that may be produced. What it holds is the activity
 * id, the jurisdiction if one was recorded, and which clause of the rule
 * refused. A ledger that quoted the call to explain why the call could not be
 * quoted would be the same disclosure the refusal prevented.
 *
 * Upserted rather than appended, keyed on the call and the rule version. A
 * timeline that re-renders refuses again, and an append-only ledger would grow a
 * row per page load: the signal a compliance officer needs is "which calls",
 * not "how many times somebody scrolled past one". `attempts` keeps the volume
 * without keeping the rows.
 */
export const callAnalysisRefusals = pgTable(
  "crm_call_analysis_refusals",
  {
    callAnalysisRefusalId: text("call_analysis_refusal_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /** No foreign key to `activities`, for the reason stated on every other
     * `activity_id` in this file: a delete must not quietly empty the ledger
     * that says a call was refused. */
    activityId: text("activity_id").notNull(),

    /** Null exactly when the reason is `jurisdiction-unrecorded`. */
    jurisdiction: text("jurisdiction"),

    /** A `CallConsentRefusal`. Text rather than an enum because adding a clause
     * to the rule must not require a migration to record it — a refusal the
     * ledger could not name would be recorded as something else or not at all. */
    reason: text("reason").notNull(),

    /** `RECORDING_CONSENT_RULE_VERSION` at the time. In the unique key, so a
     * rule change starts a fresh ledger row rather than overwriting the count of
     * what the previous rule refused. */
    ruleVersion: integer("rule_version").notNull(),

    /** The rule's own sentence, stored so the ledger reads the same a year later
     * even after the wording in the source has been improved. */
    note: text("note").notNull(),

    firstRefusedAt: timestamp("first_refused_at").defaultNow().notNull(),
    lastRefusedAt: timestamp("last_refused_at").defaultNow().notNull(),
    attempts: integer("attempts").default(1).notNull(),

    /** Who last asked. No foreign key to `users` — see above. */
    lastRequestedByUserId: text("last_requested_by_user_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_crm_call_analysis_refusals").on(
      t.organizationId,
      t.activityId,
      t.ruleVersion,
    ),
    /** The ledger read: this organisation, most recently refused first. */
    index("idx_crm_call_analysis_refusals_org").on(t.organizationId, t.lastRefusedAt),
  ],
);
