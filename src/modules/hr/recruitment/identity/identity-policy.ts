import {
  resolveProvider,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../integrations/provider-blocked";

export const IDENTITY_PLATFORM = "IDENTITY";

export const IDENTITY_STATUSES = [
  "NOT_STARTED",
  "PENDING",
  "VERIFIED",
  "FAILED",
  /**
   * The check could not be run at all — no vendor connected, or one that
   * refused.
   *
   * Distinct from FAILED, which means the vendor ran the check and the identity
   * did not hold up. Collapsing the two would let an unconfigured integration
   * read as a candidate who failed verification, which is a statement about a
   * person rather than about our setup.
   */
  "UNAVAILABLE",
] as const;

export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export interface IdentityCheckRequest {
  /** Vendor token from the candidate's own session — never a raw ID number. */
  vendorToken: string;
  externalCaseKey: string;
}

export interface IdentityCheckAccepted {
  reference: string;
  /** Trailing characters only, for a recruiter to recognise the document. */
  last4: string | null;
}

export interface IdentityAdapter {
  verify(
    credentials: ProviderCredentials,
    request: IdentityCheckRequest,
  ): Promise<IdentityCheckAccepted>;
}

/**
 * Empty, and here the emptiness protects the candidate rather than the
 * organisation.
 *
 * An adapter that answered "verified" would attach a government-identity
 * assertion to a real person on the strength of no check at all. Every other
 * fabricated state in this lane costs an employer a bad decision; this one
 * would put a false claim about somebody's identity into a hiring record.
 */
export const IDENTITY_ADAPTERS: ReadonlyMap<string, IdentityAdapter> = new Map();

export function resolveIdentity(
  credentials: ProviderCredentials | null,
): { adapter: IdentityAdapter; credentials: ProviderCredentials } | ProviderBlocked {
  return resolveProvider(
    IDENTITY_PLATFORM,
    credentials,
    IDENTITY_ADAPTERS,
    "Identity verification",
    "Check the candidate's documents yourself and record the outcome; full identity numbers are never stored here.",
  );
}

export type OfferGate =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Whether an offer may be finalised, given the job's policy and the candidate's
 * identity status.
 *
 * `UNAVAILABLE` blocks rather than passes. A job whose policy requires
 * verification is one where somebody decided the check matters; letting an
 * unconfigured vendor wave the requirement through would make the policy a
 * setting that switches itself off when it is inconvenient.
 *
 * The refusal names which of the two conditions failed, because "connect a
 * vendor" and "this candidate did not verify" are different problems with
 * different owners.
 */
export function offerGate(
  requiresVerification: boolean,
  status: IdentityStatus | null,
): OfferGate {
  if (!requiresVerification) return { allowed: true };

  switch (status ?? "NOT_STARTED") {
    case "VERIFIED":
      return { allowed: true };
    case "PENDING":
      return {
        allowed: false,
        reason: "This role requires identity verification and the check is still running.",
      };
    case "FAILED":
      return {
        allowed: false,
        reason: "This role requires identity verification and the check did not pass.",
      };
    case "UNAVAILABLE":
      return {
        allowed: false,
        reason:
          "This role requires identity verification, and no verification provider is connected to run it.",
      };
    case "NOT_STARTED":
      return {
        allowed: false,
        reason: "This role requires identity verification and it has not been started.",
      };
  }
}

/**
 * Keeps at most the last four characters of a document number.
 *
 * Returns null for anything shorter than five, so a four-character input is not
 * stored whole — the point of a suffix is that it is not the number, and
 * keeping all of a short one defeats that.
 */
export function last4Of(documentNumber: string): string | null {
  const trimmed = documentNumber.trim();
  if (trimmed.length < 5) return null;
  return trimmed.slice(-4);
}
