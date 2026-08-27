import { mentionedCompetitors } from "./competitor-mentions";
import { ANALYSER_VERSION, digestOf, readTranscript } from "./transcript";
import type { CallJudgement, CallObjection } from "./call-judgement.schemas";
import type { ConsentRegime, JurisdictionBasis, JurisdictionDetermination } from "./jurisdiction";
import type { ObservedConsent } from "./consent-gate";
import type { DiarisationBasis } from "./transcript";

/**
 * One call, read once.
 *
 * This file assembles the record and decides whether one is needed. It is the
 * source of the stored shape — `db/schema/crm/call-analysis.ts` takes its column
 * types from here by a type-only import, so the shape the domain reasons about
 * and the shape the database holds cannot drift.
 *
 * Nothing here calls a model or touches a database. The service in `analyse/`
 * gathers the facts and calls `assembleAnalysis`; the surfaces in `read/` never
 * reach this file's write half at all, which is ticket 01's third criterion and
 * is enforced structurally rather than asked for — see
 * `__tests__/read-cannot-analyse.spec.ts`.
 */

export type { CallObjection } from "./call-judgement.schemas";
export type { ConsentRegime, JurisdictionBasis } from "./jurisdiction";
export type { ObservedConsent } from "./consent-gate";
export type { DiarisationBasis } from "./transcript";

export interface CallAnalysis {
  readonly activityId: string;
  readonly partyId: string | null;
  readonly repUserId: string | null;
  readonly occurredAt: Date;

  readonly sourceDigest: string;
  readonly analyserVersion: number;
  readonly sourceChars: number;

  readonly diarisation: DiarisationBasis;
  readonly talkRatioBps: number | null;
  readonly questionShareBps: number | null;

  readonly objections: readonly CallObjection[];
  readonly competitorKeys: readonly string[];
  readonly nextStepCommitted: boolean;
  readonly nextStepQuote: string | null;

  readonly jurisdiction: string;
  readonly jurisdictionBasis: JurisdictionBasis;
  readonly consentRegime: ConsentRegime;
  readonly consentStatus: ObservedConsent;
}

/** What is already on file for a call, as far as re-analysis is concerned. */
export interface AnalysisFingerprint {
  readonly sourceDigest: string;
  readonly analyserVersion: number;
}

/**
 * Whether this transcript has to reach a model at all.
 *
 * Ticket 01's second criterion, and the one that decides the bill. Two things
 * make an analysis stale and there are exactly two, both of them content rather
 * than time: the text changed, or the analyser did. Nothing about a *reader*
 * appears in this signature, which is deliberate — there is no argument to pass
 * that would mean "somebody is looking at it", so no future caller can express
 * the re-analysis that ticket 01's third criterion forbids.
 */
export function needsAnalysis(
  existing: AnalysisFingerprint | null,
  sourceText: string,
): boolean {
  if (!existing) return true;
  if (existing.analyserVersion !== ANALYSER_VERSION) return true;
  return existing.sourceDigest !== digestOf(sourceText);
}

export interface AnalysisInput {
  readonly activityId: string;
  readonly partyId: string | null;
  readonly repUserId: string | null;
  readonly occurredAt: Date;
  readonly sourceText: string;
  readonly judgement: CallJudgement;
  readonly location: JurisdictionDetermination;
  readonly consentStatus: ObservedConsent;
  /** The tenant's own competitor vocabulary, from `crm_deal_competitors`. */
  readonly competitorKeys: readonly string[];
}

/**
 * The record, from the counted half and the judged half.
 *
 * `nextStepQuote` is dropped when nothing was committed, rather than kept as
 * context. A quote sitting beside `nextStepCommitted: false` reads, on a screen,
 * as the next step — which is the reading that turns "we should talk again" into
 * a pipeline entry, and is exactly what the prompt spends a paragraph refusing
 * to do.
 */
export function assembleAnalysis(input: AnalysisInput): CallAnalysis {
  const reading = readTranscript(input.sourceText);

  return {
    activityId: input.activityId,
    partyId: input.partyId,
    repUserId: input.repUserId,
    occurredAt: input.occurredAt,

    sourceDigest: digestOf(input.sourceText),
    analyserVersion: ANALYSER_VERSION,
    sourceChars: input.sourceText.length,

    diarisation: reading.diarisation,
    talkRatioBps: reading.talkRatioBps,
    questionShareBps: reading.questionShareBps,

    objections: input.judgement.objections,
    competitorKeys: mentionedCompetitors(input.sourceText, input.competitorKeys),
    nextStepCommitted: input.judgement.nextStepCommitted,
    nextStepQuote: input.judgement.nextStepCommitted ? input.judgement.nextStepQuote : null,

    jurisdiction: input.location.jurisdiction,
    jurisdictionBasis: input.location.basis,
    consentRegime: input.location.regime,
    consentStatus: input.consentStatus,
  };
}
