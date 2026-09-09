import { randomUUID } from "node:crypto";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { crmDealCompetitors, deals } from "./deals";

/**
 * The three states a proposal can be in, and the only three.
 *
 * `pending` is a thing the system noticed. `accepted` and `dismissed` are things
 * a person decided. The distinction is the whole ticket: a competitor on a deal
 * is a claim a sales manager will act on, and the system is allowed to raise the
 * question but never to answer it.
 */
export const COMPETITOR_SUGGESTION_STATUSES = [
  "pending",
  "accepted",
  "dismissed",
] as const;

export type CompetitorSuggestionStatus =
  (typeof COMPETITOR_SUGGESTION_STATUSES)[number];

/**
 * A rival the system noticed on a deal's timeline, waiting for a person.
 *
 * CRM-P2-12. `crm_deal_competitors` stays the record of who we are up against —
 * every row in it was typed by somebody, and this table does not change that. It
 * holds the thing one step earlier: a name that appeared in an activity, the
 * line it appeared in, and nothing else. Reading it tells you what was noticed;
 * it never tells you what is true about the deal.
 *
 * The reason it is a second table rather than a `source` column on the first is
 * that the two are read by different questions. "Who are we competing with"
 * must never return a guess, and a status column on one table makes every
 * existing reader — the deal card, the win/loss report, the forecast — depend on
 * remembering to filter. One forgotten `WHERE` and a machine's guess is on a
 * board review. Separating them makes forgetting impossible rather than
 * discouraged.
 *
 * ## Why acceptance cannot happen by itself
 *
 * Three independent things have to be true before an accepted row can exist, and
 * none of them is a convention a later author can miss:
 *
 *  1. `chk_crm_deal_competitor_suggestions_decided_by_a_person` (migration 0669)
 *     refuses any row that is not `pending` unless it names the person who
 *     decided and when, and refuses an `accepted` row that does not point at the
 *     competitor row it produced. Postgres rejects the write; there is no code
 *     path that can talk it out of that.
 *  2. There is nothing unattended to put in `decided_by_user_id`. Migration 0663
 *     established that this database has no `users` row for the system and that
 *     the sentinel id `'system'` eleven call sites were writing had never once
 *     resolved. A check that demands an actor therefore demands a person.
 *  3. The service will not write a decision without a `HumanConfirmation`
 *     (`modules/deals/competitor-suggestion.ts`), which is minted only from a
 *     request actor echoing back the exact name they were shown.
 *
 * ## Why the pointer is a composite FK that cascades
 *
 * `applied_competitor_id` closes the loop: an accepted suggestion says which row
 * it became, so provenance is answerable in one join instead of by matching
 * strings. `ON DELETE CASCADE` and not `SET NULL`, for two reasons. The check
 * above requires the pointer to be present on an accepted row, so a `SET NULL`
 * would violate it and abort the parent delete — the trap migration 0662 was
 * written for. And it is the right reading anyway: removing the competitor from
 * the deal is a person taking the decision back, which returns the name to the
 * pool for a later scan to raise again.
 */
export const crmDealCompetitorSuggestions = pgTable(
  "crm_deal_competitor_suggestions",
  {
    competitorSuggestionId: text("competitor_suggestion_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The name, exactly as the organisation writes it elsewhere.
     *
     * Copied from the tenant's own vocabulary rather than extracted from the
     * text, so accepting one cannot introduce a spelling nobody chose. The
     * matcher's job is to find an occurrence of a name a person already
     * maintains, never to name anything.
     */
    competitorKey: text("competitor_key").notNull(),

    /** Which body of text the name was found in. Today always `activity`. */
    sourceKind: text("source_kind").notNull(),

    /**
     * The activity the name was read out of.
     *
     * Provenance, not identity, and deliberately not a foreign key — the same
     * call `crm_call_analyses.activity_id` makes. A person deleting a timeline
     * entry should not silently delete the record of a decision they took
     * because of it.
     */
    sourceActivityId: text("source_activity_id").notNull(),

    /**
     * The line that named them, verbatim.
     *
     * Verbatim rather than a summary for the reason the call analysis gives:
     * this exists to be read by somebody who was not there, and a paraphrased
     * mention is a claim about what a customer meant with nothing behind it.
     */
    evidenceQuote: text("evidence_quote").notNull(),

    status: text("status")
      .$type<CompetitorSuggestionStatus>()
      .default("pending")
      .notNull(),

    /**
     * Who decided. Null exactly while `status` is `pending`.
     *
     * A plain column and not a foreign key, which is the shape
     * `crm_report_schedules.run_as_user_id` already uses for a user id that must
     * be there. A foreign key here would fight the check constraint rather than
     * help it: `ON DELETE SET NULL` would null a decided row and break the
     * check, aborting the user delete, and `RESTRICT` would block deleting
     * anyone who has ever reviewed a suggestion. What actually keeps this
     * truthful is that there is nothing unattended to put in it — migration 0663
     * established that no `users` row exists for the system and that the
     * sentinel id `'system'` has never resolved anywhere in this database.
     */
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at"),

    /**
     * Why it was dismissed, when the person said.
     *
     * Optional, because requiring a reason to reject a machine's guess makes
     * rejecting it more work than accepting it, and a queue that is cheaper to
     * accept than to refuse stops being a review.
     */
    decisionNote: text("decision_note"),

    /** The competitor row an acceptance produced or adopted. */
    appliedCompetitorId: text("applied_competitor_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /**
     * One proposal per name per deal, ever.
     *
     * This is what makes a re-scan safe to run as often as somebody likes: the
     * insert is `ON CONFLICT DO NOTHING`, so a name already proposed is not
     * proposed twice, and — the part that matters — a name somebody has already
     * dismissed is never raised again. Without it, dismissing a suggestion would
     * last until the next scan, which is a worse experience than not offering
     * one at all.
     */
    uniqueIndex("uq_crm_deal_competitor_suggestions_deal_key").on(
      table.organizationId,
      table.dealId,
      table.competitorKey,
    ),
    /** The card's read: this deal's open proposals, oldest first. */
    index("idx_crm_deal_competitor_suggestions_deal_status").on(
      table.organizationId,
      table.dealId,
      table.status,
    ),
    unique("uniq_crm_deal_competitor_suggestions_org_id").on(
      table.organizationId,
      table.competitorSuggestionId,
    ),
  ],
);

export const crmDealCompetitorSuggestionsRelations = relations(
  crmDealCompetitorSuggestions,
  ({ one }) => ({
    deal: one(deals, {
      fields: [crmDealCompetitorSuggestions.dealId],
      references: [deals.id],
    }),
    organization: one(organizations, {
      fields: [crmDealCompetitorSuggestions.organizationId],
      references: [organizations.id],
    }),
    appliedCompetitor: one(crmDealCompetitors, {
      fields: [crmDealCompetitorSuggestions.appliedCompetitorId],
      references: [crmDealCompetitors.id],
    }),
  }),
);
