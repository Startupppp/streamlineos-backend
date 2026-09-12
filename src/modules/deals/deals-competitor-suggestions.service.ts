import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  crmDealCompetitorSuggestions,
  crmDealCompetitors,
  crmOptions,
  deals,
  users,
  type CompetitorSuggestionStatus,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db, TenantTx } from "../../db/drizzle.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ActivitiesService } from "../activities/activities.service";
import {
  confirmedByPerson,
  proposeCompetitors,
  MAX_ACTIVITIES_PER_SCAN,
  type CompetitorVocabularyTerm,
  type HumanConfirmation,
} from "./competitor-suggestion";
import type {
  AcceptCompetitorSuggestionInput,
  DismissCompetitorSuggestionInput,
  ListCompetitorSuggestionsInput,
} from "./dto/competitor-suggestions.schemas";

/** The `crm_options.type` an organisation curates its rival list under. */
const COMPETITOR_OPTION_TYPE = "competitor";

/**
 * How many distinct names the matcher will consider.
 *
 * The vocabulary is a per-tenant list a person maintains, so it is small by
 * nature; the cap exists so that an import gone wrong cannot turn one scan into
 * two hundred regexes over fifty activities.
 */
const MAX_VOCABULARY_TERMS = 200;

interface SuggestionRow {
  competitorSuggestionId: string;
  competitorKey: string;
  sourceKind: string;
  sourceActivityId: string;
  evidenceQuote: string;
  status: CompetitorSuggestionStatus;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  appliedCompetitorId: string | null;
  createdAt: Date;
}

/**
 * Proposals about who a deal is competing with, and the person who decides.
 *
 * CRM-P2-12. The manual path — `DealsCompetitorsService` — is untouched and
 * remains the only way a competitor is stated. This service can do exactly two
 * things: notice a name from the deal's own timeline and file it as a question,
 * and record what a person answered.
 *
 * ## Why the scan is a request and not a sweep
 *
 * There is no cron, no outbox consumer and no after-commit hook behind this. A
 * scan happens because somebody with `crm:deals:update` pressed something on one
 * deal, which means the feature has no behaviour at all when nobody is looking
 * at it. That is the cheapest possible way to satisfy "no autonomous deal open":
 * a loop that proposes correctly today is one refactor away from a loop that
 * applies, and there is no loop.
 *
 * It also removes the questions a sweep would drag in — whose DataScope does an
 * unattended scan run under, what happens to a tenant with a hundred thousand
 * deals, who is accountable for a proposal nobody asked for. None of them have
 * to be answered, because none of them arise.
 *
 * ## Why the transcript analysis is not the source
 *
 * `crm_call_analyses` already holds `competitor_mentions` extracted from call
 * transcripts, and it is deliberately not read here. Reading it means honouring
 * `CallAnalysisVisibilityService` — a rep sees their own analysis before their
 * manager does, and a released analysis is a separate decision — and a
 * suggestion card carrying a verbatim quote out of a call would route straight
 * around that: the whole point of the quote is that it is the customer's own
 * words, which is exactly what the visibility rule governs.
 *
 * Wiring it correctly is a real option and is a different ticket, because it
 * needs the visibility service threaded through the read and a story for what a
 * suggestion looks like when its evidence is not yet releasable. Wiring it
 * incorrectly would leak call content through a card nobody thought of as call
 * content, so the source stays the deal's activity timeline, which every holder
 * of `crm:deals:read` may already read in full.
 */
@Injectable()
export class DealsCompetitorSuggestionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly activities: ActivitiesService,
  ) {}

  async list(orgId: string, dealId: number, query: ListCompetitorSuggestionsInput) {
    await this.assertDealAccess(orgId, dealId);
    return this.selectSuggestions(
      orgId,
      dealId,
      query.status ?? ("pending" satisfies CompetitorSuggestionStatus),
    );
  }

  /**
   * Reads this deal's recent timeline and files whatever it recognises.
   *
   * Returns counts beside the rows because "nothing was proposed" has three
   * different meanings — the organisation keeps no competitor list, the timeline
   * mentions nobody, or everything mentioned is already recorded — and a card
   * that cannot tell them apart shows the same shrug for all three. The first is
   * actionable (curate the list), the third is a compliment.
   */
  async scan(orgId: string, dealId: number) {
    await this.assertDealAccess(orgId, dealId);

    const [vocabulary, timeline, tracked, proposed] = await Promise.all([
      this.loadVocabulary(orgId),
      this.activities.timeline(orgId, { dealId, limit: MAX_ACTIVITIES_PER_SCAN }),
      this.db
        .select({ competitorKey: crmDealCompetitors.competitorKey })
        .from(crmDealCompetitors)
        .where(
          and(
            eq(crmDealCompetitors.orgId, orgId),
            eq(crmDealCompetitors.dealId, dealId),
          ),
        )
        .limit(MAX_VOCABULARY_TERMS),
      this.db
        .select({ competitorKey: crmDealCompetitorSuggestions.competitorKey })
        .from(crmDealCompetitorSuggestions)
        .where(
          and(
            eq(crmDealCompetitorSuggestions.organizationId, orgId),
            eq(crmDealCompetitorSuggestions.dealId, dealId),
          ),
        )
        .limit(MAX_VOCABULARY_TERMS),
    ]);

    /**
     * Both sets are excluded up front rather than left to the unique index.
     * `ON CONFLICT DO NOTHING` would give the same rows, but the counts below
     * are what the card explains itself with, and a count derived from what the
     * database silently swallowed cannot distinguish "already tracked" from
     * "already dismissed" — which are opposite things to tell somebody.
     */
    const alreadyTracked = new Set(tracked.map((row) => row.competitorKey));
    const alreadyProposed = new Set(proposed.map((row) => row.competitorKey));
    const excluded = new Set([...alreadyTracked, ...alreadyProposed]);

    const proposals = proposeCompetitors(
      vocabulary,
      timeline.data.map((entry) => ({
        activityId: entry.activityId,
        subject: entry.subject,
        body: entry.body,
      })),
      excluded,
    );

    /**
     * Typed as the table's own insert shape, and that annotation is load-bearing.
     * Inside a bare `.map()` the string literals below widen to `string`, so
     * `status` stops being the three-value union the column declares and the
     * insert no longer typechecks. Contextualising the array here keeps them
     * narrow without a cast, which is what makes the `satisfies` on `status`
     * mean anything.
     */
    const rows: (typeof crmDealCompetitorSuggestions.$inferInsert)[] =
      proposals.map((proposal) => ({
        organizationId: orgId,
        dealId,
        competitorKey: proposal.competitorKey,
        sourceKind: "activity",
        sourceActivityId: proposal.sourceActivityId,
        evidenceQuote: proposal.evidenceQuote,
        /**
         * The literal that makes an autonomous acceptance unwritable from here.
         * This is the only insert in the module, it has no `status` parameter to
         * pass, and every other column the check constraint cares about is left
         * null — so the row this path can produce is a question, and the type of
         * the values says so.
         */
        status: "pending" satisfies CompetitorSuggestionStatus,
      }));

    if (rows.length > 0)
      await this.db
        .insert(crmDealCompetitorSuggestions)
        .values(rows)
        .onConflictDoNothing({
          target: [
            crmDealCompetitorSuggestions.organizationId,
            crmDealCompetitorSuggestions.dealId,
            crmDealCompetitorSuggestions.competitorKey,
          ],
        });

    return {
      proposed: proposals.length,
      vocabularySize: vocabulary.length,
      activitiesScanned: timeline.data.length,
      alreadyTracked: alreadyTracked.size,
      alreadyProposed: alreadyProposed.size,
      suggestions: await this.selectSuggestions(orgId, dealId, "pending"),
    };
  }

  /**
   * A person agrees, and only then does a competitor row exist.
   *
   * The confirmation is minted before anything is written, so the refusal path
   * costs no transaction: a stale screen echoing the wrong name is turned away
   * at the door rather than rolled back after the insert.
   */
  async accept(
    actor: CurrentUserContext,
    dealId: number,
    suggestionId: string,
    input: AcceptCompetitorSuggestionInput,
  ) {
    await this.assertDealAccess(actor.orgId, dealId);
    const suggestion = await this.loadPending(actor.orgId, dealId, suggestionId);

    const confirmation = confirmedByPerson(
      actor,
      suggestion.competitorKey,
      input.confirmedCompetitorKey,
    );
    if (!confirmation)
      throw new BadRequestException({
        code: "SUGGESTION_CHANGED",
        message:
          "This suggestion no longer names what you were shown. Reload the deal and read it again before accepting.",
      });

    return this.db.transaction((tx) =>
      this.applyConfirmed(tx, actor.orgId, dealId, suggestionId, confirmation, input.notes),
    );
  }

  /**
   * A person says no, and the name stops being offered on this deal.
   *
   * Permanently, because the unique index means a later scan cannot re-propose
   * it. A dismissal that expired at the next scan would train people to stop
   * reading the queue, which is the failure mode that makes a suggestion feature
   * worse than none.
   */
  async dismiss(
    actor: CurrentUserContext,
    dealId: number,
    suggestionId: string,
    input: DismissCompetitorSuggestionInput,
  ) {
    await this.assertDealAccess(actor.orgId, dealId);
    await this.loadPending(actor.orgId, dealId, suggestionId);

    const [row] = await this.db
      .update(crmDealCompetitorSuggestions)
      .set({
        status: "dismissed" satisfies CompetitorSuggestionStatus,
        decidedByUserId: actor.userId,
        decidedAt: new Date(),
        decisionNote: input.reason ?? null,
      })
      .where(
        and(
          eq(crmDealCompetitorSuggestions.organizationId, actor.orgId),
          eq(crmDealCompetitorSuggestions.dealId, dealId),
          eq(crmDealCompetitorSuggestions.competitorSuggestionId, suggestionId),
          eq(crmDealCompetitorSuggestions.status, "pending"),
        ),
      )
      .returning({
        competitorSuggestionId: crmDealCompetitorSuggestions.competitorSuggestionId,
        status: crmDealCompetitorSuggestions.status,
      });

    if (!row) throw new ConflictException("This suggestion has already been decided");
    return row;
  }

  /**
   * The only write that turns a proposal into a stated fact.
   *
   * Private, and it takes a `HumanConfirmation` it cannot manufacture — the
   * brand symbol is not exported from `competitor-suggestion.ts`, so within this
   * module `confirmedByPerson` is the only source and outside it there is none.
   * The `status = 'pending'` predicate on the update is the concurrency half:
   * two reviewers clicking accept at once produce one competitor row and one
   * 409, not two rows and a lost decision.
   */
  private async applyConfirmed(
    tx: TenantTx,
    orgId: string,
    dealId: number,
    suggestionId: string,
    confirmation: HumanConfirmation,
    notes: string | undefined,
  ) {
    /**
     * Adopts an existing row rather than failing on it. Somebody typing the name
     * manually between the scan and the review is the system and the person
     * agreeing, and turning that into an error would make being diligent the
     * thing that breaks.
     */
    const [inserted] = await tx
      .insert(crmDealCompetitors)
      .values({
        orgId,
        dealId,
        competitorKey: confirmation.confirmedCompetitorKey,
        status: "active",
        notes: notes ?? null,
      })
      .onConflictDoNothing({
        target: [
          crmDealCompetitors.orgId,
          crmDealCompetitors.dealId,
          crmDealCompetitors.competitorKey,
        ],
      })
      .returning({ id: crmDealCompetitors.id });

    const competitorId =
      inserted?.id ??
      (
        await tx
          .select({ id: crmDealCompetitors.id })
          .from(crmDealCompetitors)
          .where(
            and(
              eq(crmDealCompetitors.orgId, orgId),
              eq(crmDealCompetitors.dealId, dealId),
              eq(
                crmDealCompetitors.competitorKey,
                confirmation.confirmedCompetitorKey,
              ),
            ),
          )
          .limit(1)
      )[0]?.id;

    if (!competitorId)
      throw new ConflictException("The competitor row could not be written");

    const [decided] = await tx
      .update(crmDealCompetitorSuggestions)
      .set({
        status: "accepted" satisfies CompetitorSuggestionStatus,
        decidedByUserId: confirmation.actorUserId,
        decidedAt: new Date(),
        appliedCompetitorId: competitorId,
      })
      .where(
        and(
          eq(crmDealCompetitorSuggestions.organizationId, orgId),
          eq(crmDealCompetitorSuggestions.dealId, dealId),
          eq(crmDealCompetitorSuggestions.competitorSuggestionId, suggestionId),
          eq(crmDealCompetitorSuggestions.status, "pending"),
        ),
      )
      .returning({
        competitorSuggestionId: crmDealCompetitorSuggestions.competitorSuggestionId,
        status: crmDealCompetitorSuggestions.status,
        appliedCompetitorId: crmDealCompetitorSuggestions.appliedCompetitorId,
      });

    if (!decided) throw new ConflictException("This suggestion has already been decided");
    return decided;
  }

  /**
   * The names this organisation already uses, from both places people put them.
   *
   * `crm_options` is the curated list behind CRM settings; the distinct keys on
   * `crm_deal_competitors` are the ones reps typed straight onto a deal without
   * curating anything, which on most tenants is the larger half. Reading only
   * the first would leave the feature silent exactly on the organisations that
   * never opened settings.
   */
  private async loadVocabulary(orgId: string): Promise<CompetitorVocabularyTerm[]> {
    const [options, captured] = await Promise.all([
      this.db
        .select({ key: crmOptions.key, label: crmOptions.label })
        .from(crmOptions)
        .where(
          and(
            eq(crmOptions.orgId, orgId),
            eq(crmOptions.type, COMPETITOR_OPTION_TYPE),
            eq(crmOptions.isActive, true),
          ),
        )
        .limit(MAX_VOCABULARY_TERMS),
      this.db
        .selectDistinct({ competitorKey: crmDealCompetitors.competitorKey })
        .from(crmDealCompetitors)
        .where(eq(crmDealCompetitors.orgId, orgId))
        .limit(MAX_VOCABULARY_TERMS),
    ]);

    const terms = new Map<string, CompetitorVocabularyTerm>();
    for (const option of options)
      terms.set(option.key, { competitorKey: option.key, label: option.label });
    for (const row of captured)
      if (!terms.has(row.competitorKey))
        terms.set(row.competitorKey, {
          competitorKey: row.competitorKey,
          label: row.competitorKey,
        });

    return [...terms.values()].slice(0, MAX_VOCABULARY_TERMS);
  }

  private selectSuggestions(
    orgId: string,
    dealId: number,
    status: CompetitorSuggestionStatus,
  ): Promise<SuggestionRow[]> {
    return this.db
      .select({
        competitorSuggestionId:
          crmDealCompetitorSuggestions.competitorSuggestionId,
        competitorKey: crmDealCompetitorSuggestions.competitorKey,
        sourceKind: crmDealCompetitorSuggestions.sourceKind,
        sourceActivityId: crmDealCompetitorSuggestions.sourceActivityId,
        evidenceQuote: crmDealCompetitorSuggestions.evidenceQuote,
        status: crmDealCompetitorSuggestions.status,
        decidedByUserId: crmDealCompetitorSuggestions.decidedByUserId,
        /** Projected explicitly: a users relation must never come back whole. */
        decidedByName: users.name,
        decidedAt: crmDealCompetitorSuggestions.decidedAt,
        decisionNote: crmDealCompetitorSuggestions.decisionNote,
        appliedCompetitorId: crmDealCompetitorSuggestions.appliedCompetitorId,
        createdAt: crmDealCompetitorSuggestions.createdAt,
      })
      .from(crmDealCompetitorSuggestions)
      .leftJoin(users, eq(users.id, crmDealCompetitorSuggestions.decidedByUserId))
      .where(
        and(
          eq(crmDealCompetitorSuggestions.organizationId, orgId),
          eq(crmDealCompetitorSuggestions.dealId, dealId),
          eq(crmDealCompetitorSuggestions.status, status),
        ),
      )
      .orderBy(asc(crmDealCompetitorSuggestions.createdAt))
      .limit(100);
  }

  private async loadPending(orgId: string, dealId: number, suggestionId: string) {
    const [row] = await this.db
      .select({
        competitorSuggestionId:
          crmDealCompetitorSuggestions.competitorSuggestionId,
        competitorKey: crmDealCompetitorSuggestions.competitorKey,
        status: crmDealCompetitorSuggestions.status,
      })
      .from(crmDealCompetitorSuggestions)
      .where(
        and(
          eq(crmDealCompetitorSuggestions.organizationId, orgId),
          eq(crmDealCompetitorSuggestions.dealId, dealId),
          eq(
            crmDealCompetitorSuggestions.competitorSuggestionId,
            suggestionId,
          ),
        ),
      )
      .limit(1);

    /** A miss inside the wrong tenant is a 404, never a 403 that confirms it exists. */
    if (!row) throw new NotFoundException("Suggestion not found");
    if (row.status !== "pending")
      throw new ConflictException("This suggestion has already been decided");
    return row;
  }

  private async assertDealAccess(orgId: string, dealId: number) {
    const [row] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException("Deal not found");
  }
}
