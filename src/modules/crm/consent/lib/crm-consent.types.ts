/**
 * The consent vocabulary, shared by `CrmConsentService` and the queries it
 * delegates to in this directory. The service re-exports every name here.
 */

export type ConsentChannel = "EMAIL" | "SMS" | "WHATSAPP" | "PHONE" | "POST";
export type ConsentStatus = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
export type ConsentSource =
  | "USER_ENTRY"
  | "IMPORT"
  | "WEB_FORM"
  | "UNSUBSCRIBE_LINK"
  | "API"
  | "ENRICHMENT";
export type LegalBasis =
  | "CONSENT"
  | "CONTRACT"
  | "LEGITIMATE_INTEREST"
  | "LEGAL_OBLIGATION";

export interface ConsentDecision {
  contactId: number;
  allowed: boolean;
  reason: "allowed" | "opted_out" | "expired";
}

/** What `CrmConsentService.record` is handed: one channel's new position for one contact. */
export interface ConsentRecordInput {
  contactId: number;
  channel: ConsentChannel;
  status: ConsentStatus;
  source: ConsentSource;
  legalBasis?: LegalBasis;
  sourceDetail?: string;
  expiresAt?: Date | null;
  recordedByUserId?: string | null;
}
