import { randomUUID } from "node:crypto";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import type {
  CallObjection,
  ConsentRegime,
  DiarisationBasis,
  JurisdictionBasis,
  ObservedConsent,
} from "../../../modules/call-analysis/call-analysis";

/**
 * One reading of one call, produced once and never on demand.
 *
 * The row exists because a transcript that nobody has read is a transcript that
 * tells nobody anything, and because reading one costs a model call — by some
 * distance the largest per-record model cost in the product. So the analysis is
 * a stored artefact rather than a projection: it is written by the sweep in
 * `modules/call-analysis/analyse`, and the read surface has no path to the thing
 * that writes it.
 *
 * The types come from `modules/call-analysis/call-analysis.ts` by a type-only
 * import, which is erased at compile time and leaves no runtime edge from the
 * schema into a module. Restating them here instead would put the stored shape
 * and the shape the domain reasons about in two files that agree only until
 * somebody edits one.
 *
 * Three columns are here for legal reasons rather than product ones —
 * `jurisdiction`, `jurisdiction_basis` and `consent_regime` — and the two CHECK
 * constraints below are the reason they are trustworthy. See
 * `modules/call-analysis/jurisdiction.ts`.
 */
export const crmCallAnalyses = pgTable(
  "crm_call_analyses",
  {
    crmCallAnalysisId: text("crm_call_analysis_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /** The call, on the unified timeline. One analysis per call, enforced below. */
    activityId: text("activity_id").notNull(),
    /** The counterparty, so a withdrawal of consent can find this row. */
    partyId: text("party_id"),

    /**
     * Whose call it was, and therefore who sees this first.
     *
     * No foreign key to `users`, for the reason `activities.actorUserId` states
     * at length: `scripts/purge-user.mjs` deletes every row whose column
     * references `users`, so offboarding one rep would erase the coaching record
     * of every call they ever made rather than detaching it from them.
     *
     * Nullable, and often null today. An ingested call is filed with
     * `actor_kind = 'system'` and no user at all — see the finding in
     * `call-analysis-attribution.ts`.
     */
    repUserId: text("rep_user_id"),

    /**
     * When the call happened, which is not when it was read.
     *
     * The rep's own trend is drawn on this: a backlog analysed in one sweep
     * would otherwise draw six weeks of calls as a single vertical line.
     */
    occurredAt: timestamp("occurred_at").notNull(),
    analysedAt: timestamp("analysed_at").defaultNow().notNull(),

    /**
     * What made this analysis re-usable, and what makes it stale.
     *
     * `source_digest` is a SHA-256 of exactly the text that was read. An
     * unchanged transcript therefore never reaches a model twice. `analyser_
     * version` is the second half of the same key: hashing only the transcript
     * would pin every organisation to whichever analyser first ran over it, so a
     * corrected prompt could never reach the calls it was written for.
     */
    sourceDigest: text("source_digest").notNull(),
    analyserVersion: integer("analyser_version").notNull(),
    sourceChars: integer("source_chars").notNull(),

    /**
     * Whether the transcript said who was speaking.
     *
     * Load-bearing rather than descriptive: the two metrics below are null when
     * it is `unknown`, because a talk ratio computed without knowing which side
     * is which is a number with a plausible shape and no meaning, and a rep
     * would be coached on it.
     */
    diarisation: text("diarisation").$type<DiarisationBasis>().notNull(),
    /** Our share of the words spoken, in basis points. Null when undiarised. */
    talkRatioBps: integer("talk_ratio_bps"),
    /** Share of our turns that asked something, in basis points. Null likewise. */
    questionShareBps: integer("question_share_bps"),

    /** What was pushed back on, and what happened next. Never a bare count. */
    objections: jsonb("objections").$type<readonly CallObjection[]>().notNull(),
    /**
     * Which of the tenant's own competitors came up.
     *
     * Keys from `crm_deal_competitors`, matched in the transcript, rather than
     * names a model produced. A model asked to name competitors will name
     * plausible ones, and a competitor nobody in the organisation has ever heard
     * of is worse than no answer at all.
     */
    competitorKeys: jsonb("competitor_keys").$type<readonly string[]>().notNull(),

    nextStepCommitted: boolean("next_step_committed").notNull(),
    /** The sentence the commitment was read from, so a rep can disagree with it. */
    nextStepQuote: text("next_step_quote"),

    /**
     * Where the call took place, how that was decided, and what that requires.
     *
     * `jurisdiction_basis` is not decoration. A determination made from the
     * counterparty's number and one made from the organisation's registered
     * region are different strengths of claim, and a regulator asking why a call
     * was recorded is asking exactly which of the two this was.
     */
    jurisdiction: text("jurisdiction").notNull(),
    jurisdictionBasis: text("jurisdiction_basis").$type<JurisdictionBasis>().notNull(),
    consentRegime: text("consent_regime").$type<ConsentRegime>().notNull(),
    /** The consent that was on file at the moment this was written. */
    consentStatus: text("consent_status").$type<ObservedConsent>().notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /** One analysis per call. The sweep upserts on this. */
    uniqueIndex("uniq_crm_call_analyses_activity").on(t.organizationId, t.activityId),

    /** The rep's own trend, which is the read this table exists for. */
    index("idx_crm_call_analyses_rep_occurred").on(t.organizationId, t.repUserId, t.occurredAt),

    /**
     * The read a withdrawal of consent makes.
     *
     * Withdrawal has to reach backwards through everything already stored for
     * that party, and without this it is a scan of the organisation's whole
     * analysis history per withdrawal.
     */
    index("idx_crm_call_analyses_party").on(t.organizationId, t.partyId),

    /** The manager aggregate, which is a window over the organisation. */
    index("idx_crm_call_analyses_org_occurred").on(t.organizationId, t.occurredAt),
  ],
);

export type CrmCallAnalysisRow = typeof crmCallAnalyses.$inferSelect;
export type CrmCallAnalysisInsert = typeof crmCallAnalyses.$inferInsert;
