import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { organizations } from "../../../db/schema/common/auth";
import { activities, activityParticipants } from "../../../db/schema/crm/activities";
import { crmContactChannelConsent } from "../../../db/schema/crm/consent";
import { crmDealCompetitors } from "../../../db/schema/crm/deals";
import { contactPartyMap } from "../../../db/schema/party/legacy-party-map";
import { crmCallAnalyses } from "../../../db/schema/crm/call-analysis";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { assembleAnalysis, needsAnalysis, type CallAnalysis } from "../call-analysis";
import { attributeCall } from "../call-analysis-attribution";
import {
  buildCallJudgementPrompt,
  callJudgementSchema,
  CALL_JUDGEMENT_FEATURE,
  CALL_JUDGEMENT_PROMPT_KEY,
  CALL_JUDGEMENT_PROMPT_VERSION,
  CALL_JUDGEMENT_SYSTEM_PROMPT,
} from "../call-judgement.schemas";
import {
  analysesToErase,
  mayAnalyse,
  type AnalysisRefusal,
  type ObservedConsent,
} from "../consent-gate";
import { determineJurisdiction } from "../jurisdiction";
import { ANALYSER_VERSION, capTranscript } from "../transcript";

/**
 * Every reason a candidate call was read and not analysed, so a pass can say
 * which. Fully populated rather than sparse, following `TelephonySweepResult`'s
 * tally for the reason it gives: a refusal that is absent from the report is
 * indistinguishable from one that never happened.
 */
export type RefusalTally = Record<AnalysisRefusal, number>;

const NO_REFUSALS: RefusalTally = {
  "no-transcript": 0,
  "consent-withdrawn": 0,
  "consent-not-given": 0,
  "consent-expired": 0,
};

export interface AnalysisPassResult {
  readonly considered: number;
  readonly analysed: number;
  readonly refused: RefusalTally;
  /** A provider that failed. Distinct from a refusal: nothing decided anything. */
  readonly modelFailures: number;
}

/**
 * The only thing in the product that can create a call analysis.
 *
 * It is reachable from the sweep and from nowhere else. `CallAnalysisReadModule`
 * does not import the module that provides it, no file under `../read` imports
 * anything under this directory, and `read-cannot-analyse.spec.ts` proves both
 * by walking the imports rather than by asserting somebody's intention. That is
 * ticket 01's third criterion — "re-analysis on view is impossible by
 * construction" — and it is built the way the report compiler builds tenancy: a
 * read has no way to ask for an analysis because there is nothing in reach that
 * could perform one.
 *
 * A comment saying "do not call this from a controller" would have been the
 * alternative, and it would have held until the first time somebody wanted a
 * fresh number on a screen. Analysis is by a distance the largest per-record
 * model cost in the product, so the failure mode is not a slow page — it is a
 * bill proportional to how often a popular call is opened.
 */
@Injectable()
export class CallAnalysisWriterService {
  private readonly logger = new Logger("CallAnalysis");

  /**
   * How many calls one pass may read, per organisation.
   *
   * A ceiling on the model spend of a single sweep rather than a page size. A
   * backlog drains over several passes, which is the correct behaviour for work
   * whose cost is linear in how much of it you do at once.
   */
  private static readonly MAX_ANALYSES_PER_PASS = 50;

  /** How many candidates are examined to find those. Hashing is free; reading is not. */
  private static readonly CANDIDATE_SCAN = 500;

  /**
   * How far back a pass looks.
   *
   * Ninety days rather than all history, because the coaching surfaces read a
   * rolling window and analysing a call from 2023 buys a number nobody will
   * ever see. A first pass over a long-established organisation would otherwise
   * spend the whole budget on calls that predate the feature.
   */
  private static readonly LOOKBACK_DAYS = 90;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ai: AiGatewayService,
  ) {}

  /**
   * Every stored analysis this organisation may no longer hold, deleted.
   *
   * Ticket 03's fifth criterion. It runs before the analysis pass rather than
   * after it, so a withdrawal recorded since the last sweep takes effect before
   * anything new is written — and so a pass that runs out of budget has still
   * done the part that is a legal obligation rather than a feature.
   *
   * Deleted outright, not soft-deleted. A `deleted_at` on this table would be a
   * withdrawn customer's call analysis still sitting in the database, and the
   * only difference from not honouring the withdrawal would be that our own
   * screens stopped showing it.
   */
  async reconcileConsent(organizationId: string, now: Date): Promise<{ erased: string[] }> {
    const rows = await this.db
      .select({
        crmCallAnalysisId: crmCallAnalyses.crmCallAnalysisId,
        regime: crmCallAnalyses.consentRegime,
        status: crmContactChannelConsent.status,
        expiresAt: crmContactChannelConsent.expiresAt,
      })
      .from(crmCallAnalyses)
      .leftJoin(
        contactPartyMap,
        and(
          eq(contactPartyMap.organizationId, organizationId),
          eq(contactPartyMap.partyId, crmCallAnalyses.partyId),
        ),
      )
      .leftJoin(
        crmContactChannelConsent,
        and(
          eq(crmContactChannelConsent.orgId, organizationId),
          eq(crmContactChannelConsent.contactId, contactPartyMap.contactId),
          eq(crmContactChannelConsent.channel, "PHONE"),
        ),
      )
      .where(eq(crmCallAnalyses.organizationId, organizationId));

    /**
     * Several contacts can map to one party, so a single analysis can come back
     * on several rows with several consent answers. The most restrictive of them
     * wins: if any person behind that party has said no, the answer is no. The
     * alternative — taking the first row the planner returns — makes a
     * withdrawal effective or not depending on join order.
     */
    const worst = new Map<string, { regime: "all-party" | "one-party"; consent: ObservedConsent; consentExpiresAt: Date | null }>();
    for (const row of rows) {
      const seen = worst.get(row.crmCallAnalysisId);
      const consent: ObservedConsent = row.status ?? "UNKNOWN";
      if (!seen || restrictiveness(consent) > restrictiveness(seen.consent))
        worst.set(row.crmCallAnalysisId, {
          regime: row.regime,
          consent,
          consentExpiresAt: row.expiresAt ?? seen?.consentExpiresAt ?? null,
        });
    }

    const doomed = analysesToErase(
      [...worst.entries()].map(([crmCallAnalysisId, facts]) => ({
        crmCallAnalysisId,
        ...facts,
      })),
      now,
    );

    if (doomed.length === 0) return { erased: [] };

    await this.db
      .delete(crmCallAnalyses)
      .where(
        and(
          eq(crmCallAnalyses.organizationId, organizationId),
          inArray(crmCallAnalyses.crmCallAnalysisId, doomed),
        ),
      );

    this.logger.log(
      `Erased ${String(doomed.length)} call ${doomed.length === 1 ? "analysis" : "analyses"} in org ${organizationId} after a change of consent`,
    );
    return { erased: doomed };
  }

  /**
   * The calls that have changed since anybody read them, read.
   *
   * The digest comparison happens in this process rather than in SQL on purpose:
   * hashing five hundred bodies costs microseconds, and expressing
   * `needsAnalysis` as a predicate would put the caching rule in two places
   * written in two languages.
   */
  async analyseDue(organizationId: string, now: Date): Promise<AnalysisPassResult> {
    const since = new Date(
      now.getTime() - CallAnalysisWriterService.LOOKBACK_DAYS * 86_400_000,
    );

    const candidates = await this.db
      .select({
        activityId: activities.activityId,
        partyId: activities.partyId,
        occurredAt: activities.occurredAt,
        body: activities.body,
        actorKind: activities.actorKind,
        actorUserId: activities.actorUserId,
        assigneeUserId: activities.assigneeUserId,
        storedDigest: crmCallAnalyses.sourceDigest,
        storedVersion: crmCallAnalyses.analyserVersion,
      })
      .from(activities)
      .leftJoin(
        crmCallAnalyses,
        and(
          eq(crmCallAnalyses.organizationId, organizationId),
          eq(crmCallAnalyses.activityId, activities.activityId),
        ),
      )
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.kind, "call"),
          isNull(activities.deletedAt),
          isNotNull(activities.body),
          gte(activities.occurredAt, since),
        ),
      )
      .orderBy(desc(activities.occurredAt))
      .limit(CallAnalysisWriterService.CANDIDATE_SCAN);

    const due = candidates
      .map((row) => ({ ...row, sourceText: capTranscript(row.body ?? "") }))
      .filter((row) =>
        needsAnalysis(
          row.storedDigest !== null && row.storedVersion !== null
            ? { sourceDigest: row.storedDigest, analyserVersion: row.storedVersion }
            : null,
          row.sourceText,
        ),
      )
      .slice(0, CallAnalysisWriterService.MAX_ANALYSES_PER_PASS);

    if (due.length === 0)
      return {
        considered: candidates.length,
        analysed: 0,
        refused: { ...NO_REFUSALS },
        modelFailures: 0,
      };

    const [competitorKeys, organisationCountry] = await Promise.all([
      this.competitorKeys(organizationId),
      this.organisationCountry(organizationId),
    ]);

    const refused: RefusalTally = { ...NO_REFUSALS };
    let analysed = 0;
    let modelFailures = 0;

    for (const call of due) {
      const consent = await this.consentFor(organizationId, call.partyId);
      const location = determineJurisdiction({
        counterpartyNumber: await this.counterpartyNumber(organizationId, call.activityId),
        organisationCountry,
      });

      const verdict = mayAnalyse({
        now,
        regime: location.regime,
        hasTranscript: call.sourceText.trim().length > 0,
        consent: consent.status,
        consentExpiresAt: consent.expiresAt,
      });

      if (!verdict.mayAnalyse) {
        refused[verdict.reason] += 1;
        continue;
      }

      const judgement = await this.ai.invokeStructured({
        actor: { orgId: organizationId, userId: null },
        feature: CALL_JUDGEMENT_FEATURE,
        prompt: {
          system: CALL_JUDGEMENT_SYSTEM_PROMPT,
          user: buildCallJudgementPrompt(call.sourceText),
          promptKey: CALL_JUDGEMENT_PROMPT_KEY,
          promptVersion: CALL_JUDGEMENT_PROMPT_VERSION,
        },
        schema: callJudgementSchema,
        maxTokens: 1_500,
      });

      /**
       * A provider failure writes nothing at all.
       *
       * Not a row with empty objections, which would carry a digest and would
       * therefore never be retried — the caching rule would have permanently
       * recorded "this call has nothing in it" on the strength of a timeout.
       */
      if (!judgement.ok) {
        modelFailures += 1;
        continue;
      }

      await this.store(
        organizationId,
        assembleAnalysis({
          activityId: call.activityId,
          partyId: call.partyId,
          repUserId: attributeCall({
            actorKind: call.actorKind,
            actorUserId: call.actorUserId,
            assigneeUserId: call.assigneeUserId,
          }).repUserId,
          occurredAt: call.occurredAt,
          sourceText: call.sourceText,
          judgement: judgement.data,
          location,
          consentStatus: consent.status,
          competitorKeys,
        }),
      );
      analysed += 1;
    }

    return { considered: candidates.length, analysed, refused, modelFailures };
  }

  private async store(organizationId: string, analysis: CallAnalysis): Promise<void> {
    await this.db
      .insert(crmCallAnalyses)
      .values({
        organizationId,
        activityId: analysis.activityId,
        partyId: analysis.partyId,
        repUserId: analysis.repUserId,
        occurredAt: analysis.occurredAt,
        sourceDigest: analysis.sourceDigest,
        analyserVersion: analysis.analyserVersion,
        sourceChars: analysis.sourceChars,
        diarisation: analysis.diarisation,
        talkRatioBps: analysis.talkRatioBps,
        questionShareBps: analysis.questionShareBps,
        objections: analysis.objections,
        competitorKeys: analysis.competitorKeys,
        nextStepCommitted: analysis.nextStepCommitted,
        nextStepQuote: analysis.nextStepQuote,
        jurisdiction: analysis.jurisdiction,
        jurisdictionBasis: analysis.jurisdictionBasis,
        consentRegime: analysis.consentRegime,
        consentStatus: analysis.consentStatus,
      })
      .onConflictDoUpdate({
        target: [crmCallAnalyses.organizationId, crmCallAnalyses.activityId],
        set: {
          repUserId: analysis.repUserId,
          sourceDigest: analysis.sourceDigest,
          analyserVersion: ANALYSER_VERSION,
          sourceChars: analysis.sourceChars,
          analysedAt: new Date(),
          diarisation: analysis.diarisation,
          talkRatioBps: analysis.talkRatioBps,
          questionShareBps: analysis.questionShareBps,
          objections: analysis.objections,
          competitorKeys: analysis.competitorKeys,
          nextStepCommitted: analysis.nextStepCommitted,
          nextStepQuote: analysis.nextStepQuote,
          jurisdiction: analysis.jurisdiction,
          jurisdictionBasis: analysis.jurisdictionBasis,
          consentRegime: analysis.consentRegime,
          consentStatus: analysis.consentStatus,
        },
      });
  }

  /**
   * The number the other side rang from.
   *
   * `role = 'from'` is the counterparty because the telephony adapter refuses
   * outbound calls outright — an accepted call is one somebody made *to* us, so
   * whoever spoke first is who we need to place. When ticket 12 lands outbound
   * calls this stops being true, and the jurisdiction determination has to read
   * the direction the event will by then be carrying.
   */
  private async counterpartyNumber(
    organizationId: string,
    activityId: string,
  ): Promise<string | null> {
    const [participant] = await this.db
      .select({ address: activityParticipants.address })
      .from(activityParticipants)
      .where(
        and(
          eq(activityParticipants.organizationId, organizationId),
          eq(activityParticipants.activityId, activityId),
          eq(activityParticipants.role, "from"),
        ),
      )
      .limit(1);

    return participant?.address ?? null;
  }

  /**
   * The counterparty's consent to be reached on the phone, from the CRM's own
   * consent model.
   *
   * A party nobody has mapped to a contact resolves to `UNKNOWN`, which in an
   * all-party jurisdiction refuses the analysis. That is the fail-closed
   * direction: an unmapped party is a person we know nothing about, and
   * "nothing" is not agreement.
   */
  private async consentFor(
    organizationId: string,
    partyId: string | null,
  ): Promise<{ status: ObservedConsent; expiresAt: Date | null }> {
    if (!partyId) return { status: "UNKNOWN", expiresAt: null };

    const rows = await this.db
      .select({
        status: crmContactChannelConsent.status,
        expiresAt: crmContactChannelConsent.expiresAt,
      })
      .from(contactPartyMap)
      .innerJoin(
        crmContactChannelConsent,
        and(
          eq(crmContactChannelConsent.orgId, organizationId),
          eq(crmContactChannelConsent.contactId, contactPartyMap.contactId),
          eq(crmContactChannelConsent.channel, "PHONE"),
        ),
      )
      .where(
        and(
          eq(contactPartyMap.organizationId, organizationId),
          eq(contactPartyMap.partyId, partyId),
        ),
      );

    if (rows.length === 0) return { status: "UNKNOWN", expiresAt: null };

    // The most restrictive answer wins, for the reason `reconcileConsent` gives.
    return rows.reduce<{ status: ObservedConsent; expiresAt: Date | null }>(
      (worstSoFar, row) =>
        restrictiveness(row.status) > restrictiveness(worstSoFar.status)
          ? { status: row.status, expiresAt: row.expiresAt }
          : worstSoFar,
      { status: rows[0]!.status, expiresAt: rows[0]!.expiresAt },
    );
  }

  /** The competitor vocabulary this organisation actually uses, on its own deals. */
  private async competitorKeys(organizationId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ competitorKey: crmDealCompetitors.competitorKey })
      .from(crmDealCompetitors)
      .where(eq(crmDealCompetitors.orgId, organizationId));

    return rows.map((row) => row.competitorKey);
  }

  private async organisationCountry(organizationId: string): Promise<string | null> {
    const [org] = await this.db
      .select({ country: organizations.country })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    return org?.country ?? null;
  }
}

/** OPTED_OUT beats UNKNOWN beats OPTED_IN, when several contacts share a party. */
function restrictiveness(status: ObservedConsent): number {
  switch (status) {
    case "OPTED_OUT":
      return 2;
    case "UNKNOWN":
      return 1;
    case "OPTED_IN":
      return 0;
  }
}
