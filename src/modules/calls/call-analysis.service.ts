import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities } from "../../db/schema";
import {
  callAnalyses,
  type CallObjection,
  type CompetitorMention,
} from "../../db/schema/crm/call-analysis";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import {
  buildCallAnalysisPrompt,
  callAnalysisJudgementSchema,
  CALL_ANALYSIS_ANALYZER_VERSION,
  CALL_ANALYSIS_FEATURE,
  CALL_ANALYSIS_PROMPT_KEY,
  CALL_ANALYSIS_PROMPT_VERSION,
  CALL_ANALYSIS_SYSTEM_PROMPT,
  MAX_TRANSCRIPT_CHARS,
  type CallAnalysisJudgement,
} from "./call-analysis.contract";
import { normaliseTranscript, transcriptHash } from "./transcript-hash";
import {
  parseDiarisedTranscript,
  questionRateBps,
  speakerMetrics,
} from "./transcript-metrics";

/**
 * One completed call, analysed once.
 *
 * How a call reaches this service, established by reading the ingress adapters
 * rather than assumed. `telephony-call-log.ts` reads a carrier's call log and
 * hands each entry to `telephonyCallToInboundEvent`, which puts the provider's
 * transcript — and nothing else — in `InboundCommunicationEvent.body`. The
 * ingress workflow then writes one `activities` row per event with
 * `kind = 'call'` and `body` set to that transcript. So a call and its
 * transcript are an `activities` row today; there is no separate call table,
 * and inventing one would be a second store for something the timeline already
 * holds.
 *
 * One honest consequence of that reading, stated here rather than discovered
 * later: the Twilio call-log adapter always sets `transcript: null`, on purpose
 * and with a docblock explaining why — a transcript is a separate provider
 * resource it refuses to invent a request for. So calls that reach this service
 * with a transcript today are the ones filed through
 * `POST /crm/ingress/inbound` with `channel: "call"` and a body, which is the
 * seam's supported path and the one every test drives. Nothing here fetches a
 * transcript from a provider; that is the carrier adapter's job and it is
 * unwired.
 *
 * The caching rule, which is the ticket rather than an optimisation: the key is
 * (organisation, transcript hash, analyser version). Asking for the same
 * transcript twice returns the first answer verbatim and makes no second model
 * call — not "a similar answer cheaply", the identical row. That matters
 * because a language model asked the same question twice does not agree with
 * itself, and a customer's record showing a different set of objections
 * depending on when somebody last opened it is worse than showing none.
 *
 * Failures are never cached. A model call refused for want of credits, or a
 * provider outage, must not write a row — a cached failure would make the
 * transcript permanently unanalysable, because the cache is keyed on the
 * transcript and nothing would ever ask again.
 */

export interface CallAnalysis {
  readonly activityId: string;
  readonly transcriptHash: string;
  readonly analyzerVersion: number;
  /** Basis points of 10000. Null when the transcript is not speaker-attributed. */
  readonly talkRatioBps: number | null;
  /** Derived from the two counts below, so every surface divides identically. */
  readonly questionRateBps: number | null;
  readonly repTurnCount: number | null;
  readonly repQuestionCount: number | null;
  readonly objections: readonly CallObjection[];
  readonly competitorMentions: readonly CompetitorMention[];
  readonly nextStepCommitted: boolean;
  readonly nextStep: string | null;
  readonly model: string | null;
  readonly transcriptChars: number;
  readonly analysedAt: Date;
}

/**
 * Why a call was not analysed, named so the caller can say which.
 *
 * A single `null` would collapse "this activity is a meeting", "this call has
 * no transcript" and "the provider is down" into one silence, and the third of
 * those is worth retrying while the first two never are.
 */
export type CallAnalysisRefusal =
  | "not-found"
  | "not-a-call"
  | "not-completed"
  | "no-transcript"
  | "analysis-unavailable";

export type CallAnalysisOutcome =
  | {
      readonly ok: true;
      /** True when this cost nothing: the transcript had been analysed before. */
      readonly cached: boolean;
      readonly analysis: CallAnalysis;
    }
  | { readonly ok: false; readonly reason: CallAnalysisRefusal; readonly note: string };

interface CallRow {
  readonly activityId: string;
  readonly kind: string;
  readonly body: string | null;
  readonly occurredAt: Date;
}

type AnalysisRow = typeof callAnalyses.$inferSelect;

@Injectable()
export class CallAnalysisService {
  private readonly logger = new Logger("CallAnalysis");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  /**
   * The analysis for a call, if one has already been produced.
   *
   * Never analyses. A read that could spend a credit is a read nobody can put
   * on a page that loads on scroll, and the whole point of the hash key is that
   * the expensive path is entered deliberately.
   */
  async find(organizationId: string, activityId: string): Promise<CallAnalysis | null> {
    const call = await this.loadCall(organizationId, activityId);
    const transcript = usableTranscript(call);
    if (!transcript) return null;

    const row = await this.cached(organizationId, transcriptHash(transcript));
    return row ? toAnalysis(row) : null;
  }

  /**
   * Analyse the call, or hand back the analysis this transcript already has.
   *
   * The cache is consulted before anything is built, so the free path does not
   * even construct a prompt.
   */
  async analyse(
    organizationId: string,
    actorUserId: string | null,
    activityId: string,
  ): Promise<CallAnalysisOutcome> {
    const call = await this.loadCall(organizationId, activityId);
    if (!call) return refuse("not-found", "That call is not on this organisation's timeline.");
    if (call.kind !== "call")
      return refuse("not-a-call", `That activity is a ${call.kind}, not a call.`);

    /**
     * A call in the future is a plan somebody typed, not a call that happened.
     * Analysing one would attribute objections and a talk ratio to a
     * conversation nobody has had yet.
     */
    if (call.occurredAt.getTime() > Date.now())
      return refuse("not-completed", "That call has not happened yet.");

    const transcript = usableTranscript(call);
    if (!transcript)
      return refuse(
        "no-transcript",
        "That call has no transcript. Nothing is inferred from a call's duration or its participants.",
      );

    const hash = transcriptHash(transcript);
    const existing = await this.cached(organizationId, hash);
    if (existing) return { ok: true, cached: true, analysis: toAnalysis(existing) };

    const judged = await this.judge(organizationId, actorUserId, transcript, call.occurredAt);
    if (!judged.ok) return judged;

    await this.store(organizationId, activityId, hash, transcript, judged);

    /**
     * Read back rather than returning what was just built. Under a concurrent
     * second request the insert above is a no-op and the winner's row is the
     * one every later reader will see — so returning the local object would
     * hand this caller an answer that exists nowhere and that the next refresh
     * would contradict.
     */
    const stored = await this.cached(organizationId, hash);
    if (!stored)
      return refuse("analysis-unavailable", "The analysis could not be recorded. Try again.");

    return { ok: true, cached: false, analysis: toAnalysis(stored) };
  }

  private async loadCall(
    organizationId: string,
    activityId: string,
  ): Promise<CallRow | null> {
    const [row] = await this.db
      .select({
        activityId: activities.activityId,
        kind: activities.kind,
        body: activities.body,
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.activityId, activityId),
          // A deleted activity is gone from every timeline; it must not be
          // reachable through a second endpoint that forgot to say so.
          isNull(activities.deletedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /** The cache read. The organisation predicate is not optional — see the schema. */
  private async cached(
    organizationId: string,
    hash: string,
  ): Promise<AnalysisRow | null> {
    const [row] = await this.db
      .select()
      .from(callAnalyses)
      .where(
        and(
          eq(callAnalyses.organizationId, organizationId),
          eq(callAnalyses.transcriptHash, hash),
          eq(callAnalyses.analyzerVersion, CALL_ANALYSIS_ANALYZER_VERSION),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * The one model call, through the gateway and nowhere else.
   *
   * `charge` and the default redaction are the reason this goes through
   * `AiGatewayService` rather than a provider SDK: a transcript is the most
   * personal text in the CRM, and the gateway's redaction pass runs over the
   * prompt before it leaves the process. `dedupe` collapses two simultaneous
   * requests for the same transcript into one provider call inside a node — the
   * unique index is what handles the same race across nodes.
   */
  private async judge(
    organizationId: string,
    actorUserId: string | null,
    transcript: string,
    occurredAt: Date,
  ): Promise<
    | { ok: true; judgement: CallAnalysisJudgement; model: string | null }
    | { ok: false; reason: CallAnalysisRefusal; note: string }
  > {
    const diarised = parseDiarisedTranscript(transcript);

    const result = await this.gateway.invokeStructuredWithUsage<CallAnalysisJudgement>({
      actor: { orgId: organizationId, userId: actorUserId },
      feature: CALL_ANALYSIS_FEATURE,
      /**
       * The slower tier, unusually. Every other decision this branch makes is
       * one sentence about one message; this is a whole conversation, and the
       * output is quoted back to a customer-facing team. The cost argument is
       * also weaker here than anywhere else in the product, because the cache
       * means each transcript is paid for once ever.
       */
      tier: "standard",
      schema: callAnalysisJudgementSchema,
      charge: true,
      maxTokens: 2000,
      prompt: {
        system: CALL_ANALYSIS_SYSTEM_PROMPT,
        user: buildCallAnalysisPrompt({ transcript, diarised, occurredAt }),
        promptKey: CALL_ANALYSIS_PROMPT_KEY,
        promptVersion: CALL_ANALYSIS_PROMPT_VERSION,
      },
    });

    if (!result.ok) {
      this.logger.warn(`call analysis did not complete for ${organizationId}: ${result.kind}`);
      return { ok: false, reason: "analysis-unavailable", note: result.message };
    }

    return { ok: true, judgement: result.data, model: result.aiUsage.model };
  }

  private async store(
    organizationId: string,
    activityId: string,
    hash: string,
    transcript: string,
    judged: { judgement: CallAnalysisJudgement; model: string | null },
  ): Promise<void> {
    const diarised = parseDiarisedTranscript(transcript);
    const metrics = diarised
      ? speakerMetrics(diarised, judged.judgement.repSpeakers)
      : null;

    const nextStep = judged.judgement.nextStep?.trim() || null;
    /**
     * A commitment nobody could name is not a commitment.
     *
     * The migration's CHECK states the same arc, and the coercion is here
     * rather than left to the database on purpose: a 23514 on a model's answer
     * would fail the request and lose a call that was paid for, whereas a
     * `true` with nothing to point at is a next-step rate that counts every
     * polite goodbye.
     */
    const committed = judged.judgement.nextStepCommitted && nextStep !== null;

    await this.db
      .insert(callAnalyses)
      .values({
        organizationId,
        transcriptHash: hash,
        analyzerVersion: CALL_ANALYSIS_ANALYZER_VERSION,
        activityId,
        talkRatioBps: metrics?.talkRatioBps ?? null,
        repTurnCount: metrics?.repTurnCount ?? null,
        repQuestionCount: metrics?.repQuestionCount ?? null,
        objections: judged.judgement.objections.map(toObjection),
        competitorMentions: judged.judgement.competitorMentions.map((mention) => ({
          name: mention.name,
          quote: mention.quote,
        })),
        nextStepCommitted: committed,
        nextStep: committed ? nextStep : null,
        model: judged.model,
        promptKey: CALL_ANALYSIS_PROMPT_KEY,
        promptVersion: CALL_ANALYSIS_PROMPT_VERSION,
        transcriptChars: transcript.length,
      })
      /**
       * The loser of a race keeps the winner's answer. Overwriting would break
       * the one promise this table makes — that the same transcript reads the
       * same — for whoever was already looking at it.
       */
      .onConflictDoNothing();
  }
}

function refuse(
  reason: CallAnalysisRefusal,
  note: string,
): { ok: false; reason: CallAnalysisRefusal; note: string } {
  return { ok: false, reason, note };
}

/**
 * The transcript as it will be hashed and as it will be prompted, or null.
 *
 * One function so those two can never diverge; see `transcript-hash.ts` for why
 * that matters. The cap is applied before the hash, so a transcript that
 * differs only past the cap is correctly one cache entry — the analysis of both
 * would be identical anyway, having read the same characters.
 */
function usableTranscript(call: CallRow | null): string | null {
  if (!call || call.kind !== "call") return null;
  const normalised = normaliseTranscript(call.body ?? "");
  if (!normalised) return null;
  return normalised.slice(0, MAX_TRANSCRIPT_CHARS);
}

function toObjection(raw: CallAnalysisJudgement["objections"][number]): CallObjection {
  const response = raw.response?.trim() || null;
  return {
    quote: raw.quote,
    handling: raw.handling,
    // An objection nobody answered has no reply to quote, whatever the model
    // put in the field.
    response: raw.handling === "unaddressed" ? null : response,
  };
}

function toAnalysis(row: AnalysisRow): CallAnalysis {
  return {
    activityId: row.activityId,
    transcriptHash: row.transcriptHash,
    analyzerVersion: row.analyzerVersion,
    talkRatioBps: row.talkRatioBps,
    questionRateBps: questionRateBps(row.repQuestionCount, row.repTurnCount),
    repTurnCount: row.repTurnCount,
    repQuestionCount: row.repQuestionCount,
    objections: row.objections ?? [],
    competitorMentions: row.competitorMentions ?? [],
    nextStepCommitted: row.nextStepCommitted,
    nextStep: row.nextStep,
    model: row.model,
    transcriptChars: row.transcriptChars,
    analysedAt: row.createdAt,
  };
}
