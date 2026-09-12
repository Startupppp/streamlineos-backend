import type { CallConsentVerdict, ConsentMethod } from "../call-recording-consent";

/*
 * The shapes `CallRecordingConsentService` hands its callers. The service
 * re-exports every name here.
 */

/** What a refusal looks like to a caller that has to act on it. */
export interface CallConsentDecision {
  readonly activityId: string;
  readonly verdict: CallConsentVerdict;
  /** The citation behind the regime, for a compliance reviewer. Null when it defaulted. */
  readonly basis: string | null;
}

export interface CallRecordingConsentAttestation {
  readonly jurisdiction: string;
  readonly orgPartyConsented: boolean;
  readonly counterpartyConsented: boolean;
  readonly counterpartyMethod: ConsentMethod | null;
  readonly counterpartyWithdrawn: boolean;
  readonly note: string | null;
}

export type AttestOutcome =
  | { readonly ok: true; readonly decision: CallConsentDecision }
  | { readonly ok: false; readonly reason: "not-found" | "bad-jurisdiction"; readonly note: string };

export interface RefusalLedgerRow {
  readonly activityId: string;
  readonly jurisdiction: string | null;
  readonly reason: string;
  readonly note: string;
  readonly ruleVersion: number;
  readonly attempts: number;
  readonly firstRefusedAt: Date;
  readonly lastRefusedAt: Date;
}
