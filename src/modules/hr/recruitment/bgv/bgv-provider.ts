import {
  resolveProvider,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../integrations/provider-blocked";

export const BGV_PLATFORM = "BACKGROUND_CHECK";

/**
 * What an agency is asked to verify.
 *
 * Deliberately narrow. An AuthBridge-class check needs a name, a contact and
 * the specific checks requested; it does not need the résumé, the interview
 * scorecards, the salary on the offer or the rest of the candidate record. Every
 * field here is one somebody would have to justify sending to a third party, so
 * the type is the place that justification is enforced rather than a comment on
 * the call site.
 */
export interface BgvCaseRequest {
  fullName: string;
  email: string;
  phone: string | null;
  /** Which checks the organisation is buying — identity, education, employment. */
  checks: readonly string[];
  /** Ours, so the callback can be matched back without the agency echoing PII. */
  externalCaseKey: string;
}

export interface BgvCaseAccepted {
  /** The agency's own case id, which every later verdict must carry. */
  reference: string;
}

export interface BgvAdapter {
  /**
   * Opens a case. Must throw rather than return on a refusal: a case that was
   * not opened must never leave the candidate looking `INITIATED`.
   */
  open(credentials: ProviderCredentials, request: BgvCaseRequest): Promise<BgvCaseAccepted>;
}

/**
 * Empty, and the emptiness is load-bearing.
 *
 * `CLEARED` on a candidate is what an offer gets released against. An adapter
 * that answered "cleared" without an agency behind it would be the exact
 * failure the brief names — a verdict reported by code that made no network
 * call — and unlike a missing job-board post, nobody would ever notice, because
 * a clearance looks the same whether or not anybody checked.
 */
export const BGV_ADAPTERS: ReadonlyMap<string, BgvAdapter> = new Map();

export function resolveBgv(
  credentials: ProviderCredentials | null,
): { adapter: BgvAdapter; credentials: ProviderCredentials } | ProviderBlocked {
  return resolveProvider(
    BGV_PLATFORM,
    credentials,
    BGV_ADAPTERS,
    "Background verification",
    "Run the check with your agency directly and record the outcome here; it is stored as a recruiter's record, not the agency's.",
  );
}

/** The checks an organisation can ask for, as the settings screen offers them. */
export const BGV_CHECK_TYPES = [
  "IDENTITY",
  "ADDRESS",
  "EDUCATION",
  "EMPLOYMENT",
  "CRIMINAL",
  "REFERENCE",
] as const;
export type BgvCheckType = (typeof BGV_CHECK_TYPES)[number];
