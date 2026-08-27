import type { ConsentRegime } from "./jurisdiction";

/**
 * Whether a call may be analysed, and whether an analysis already stored may
 * still be held.
 *
 * Ticket 03. One predicate answers both questions, and that is the whole of the
 * fifth criterion — "withdrawal of consent removes the analysis, not only future
 * analyses". A separate deletion rule would be a second reading of the same law
 * written by a different person on a different day, and the two would agree
 * until the first time one of them was edited. Here, erasure is `mayAnalyse`
 * evaluated again over what already exists: anything the rule would refuse to
 * create today is deleted today.
 *
 * The consent it reads is the CRM's existing one — `crm_contact_channel_consent`
 * on channel `PHONE`, the same rows `CrmConsentService.filterSendable` reads and
 * the same three statuses. Ticket 03's first criterion forbids a second consent
 * model, and it is right to: an organisation that has to record a customer's
 * wishes twice records them once.
 */

/** The vocabulary of `crm_contact_channel_consent`, unchanged. */
export type ObservedConsent = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";

export type AnalysisRefusal =
  | "no-transcript"
  | "consent-withdrawn"
  | "consent-not-given"
  | "consent-expired";

export type AnalysisVerdict =
  | { readonly mayAnalyse: true }
  | { readonly mayAnalyse: false; readonly reason: AnalysisRefusal };

export interface CallConsentFacts {
  readonly now: Date;
  readonly regime: ConsentRegime;
  /**
   * Whether there is anything to read.
   *
   * A call with no transcript produces no analysis rather than an empty one —
   * ticket 01's fourth criterion. An empty analysis is worse than a missing one
   * because it is indistinguishable from a call that genuinely went nowhere, and
   * a rep would have to argue with a row of zeroes.
   */
  readonly hasTranscript: boolean;
  /** The counterparty's consent on channel `PHONE`, as it stands right now. */
  readonly consent: ObservedConsent;
  readonly consentExpiresAt: Date | null;
}

/**
 * The decision, in the order the reasons matter.
 *
 * The order is the argument. A withdrawal is checked before the regime because
 * it binds in both: a one-party jurisdiction makes recording lawful without the
 * other side's agreement, and it does not make it lawful after they have told us
 * to stop. The legal minimum is not the promise the product made.
 */
export function mayAnalyse(facts: CallConsentFacts): AnalysisVerdict {
  if (!facts.hasTranscript) return { mayAnalyse: false, reason: "no-transcript" };

  if (facts.consent === "OPTED_OUT")
    return { mayAnalyse: false, reason: "consent-withdrawn" };

  /**
   * An expired opt-in is not an opt-in, and `<=` for the reason
   * `evaluateGuardrails` gives: the other reading hands the benefit of a
   * rounding error to the party who did not ask to be recorded.
   *
   * Only in an all-party jurisdiction. Where our own consent is sufficient, an
   * expired *contact* permission says nothing about whether we may read a call
   * we were on — it is a marketing permission, and treating it as a recording
   * ban would delete analyses for a reason nobody stated.
   */
  const expired =
    facts.consentExpiresAt !== null &&
    facts.consentExpiresAt.getTime() <= facts.now.getTime();

  if (facts.regime === "all-party") {
    if (expired) return { mayAnalyse: false, reason: "consent-expired" };
    if (facts.consent !== "OPTED_IN")
      return { mayAnalyse: false, reason: "consent-not-given" };
  }

  return { mayAnalyse: true };
}

/** What a refusal says in the ledger and to whoever asks why a call is blank. */
export function refusalSummary(reason: AnalysisRefusal): string {
  switch (reason) {
    case "no-transcript":
      return "The call has no transcript, so there was nothing to read.";
    case "consent-withdrawn":
      return "The other party withdrew their consent, so nothing about this call is kept.";
    case "consent-not-given":
      return "This call took place where everyone on it must agree to be recorded, and no agreement is on file.";
    case "consent-expired":
      return "The agreement to record this person had expired by the time of the call.";
  }
}

/**
 * One analysis already on file, reduced to what the rule needs to judge it.
 *
 * `hasTranscript` is fixed true rather than carried: the row exists, so a
 * transcript existed. Re-deriving it from the activity would make erasure
 * dependent on the call body still being there, and a transcript deleted for its
 * own retention reasons would then *stop* the analysis of it being deleted.
 */
export interface StoredAnalysisFacts {
  readonly crmCallAnalysisId: string;
  readonly regime: ConsentRegime;
  readonly consent: ObservedConsent;
  readonly consentExpiresAt: Date | null;
}

/**
 * The analyses that may no longer be held, given consent as it stands now.
 *
 * This is the criterion made mechanical. A withdrawal does not schedule
 * anything, does not set a flag and does not suppress a future run — the next
 * pass asks the same question of every stored row that it asks of every new
 * call, and the rows that now fail it are deleted outright. So a customer who
 * withdraws consent on a call from March has the March analysis removed, which
 * is the difference between honouring a withdrawal and merely obeying it going
 * forward.
 */
export function analysesToErase(
  stored: readonly StoredAnalysisFacts[],
  now: Date,
): string[] {
  return stored
    .filter(
      (row) =>
        !mayAnalyse({
          now,
          regime: row.regime,
          hasTranscript: true,
          consent: row.consent,
          consentExpiresAt: row.consentExpiresAt,
        }).mayAnalyse,
    )
    .map((row) => row.crmCallAnalysisId);
}
