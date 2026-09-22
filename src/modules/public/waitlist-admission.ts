/**
 * Whether a waitlist entry may be admitted, and whether a token may be claimed.
 *
 * Phase 3, ticket 13. Kept pure and separate from the service because these are
 * the two decisions that actually matter -- everything around them is a row
 * write and an email -- and because "can this token still create an
 * organisation" is a question that should be answerable in a test rather than
 * against a database.
 *
 * The distinction this file exists to hold: **admission is gated, claiming is
 * not.** Only somebody with the permission mints a token; anybody holding one
 * may spend it. That asymmetry is the whole security model, so the claim side
 * refuses on every axis it can check -- consumed, expired, wrong state -- rather
 * than trusting that a token in hand implies a token that should work.
 */

/** Seven days, matching `invitations`. Long enough for a holiday, short enough to expire. */
export const ADMISSION_TOKEN_DAYS = 7;

export interface AdmissionCandidate {
  readonly status: string;
  readonly claimedAt: Date | null;
}

export type AdmissionCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Re-admitting an INVITED entry is allowed; re-admitting a CLAIMED one is not.
 *
 * The first is how somebody who lost the email gets another one, and refusing it
 * would mean the only recovery is a database edit. The second would mint a
 * second organisation for a person who already has one, which is not a resend --
 * it is a duplicate tenant, and the support conversation that follows is about
 * which of the two has their data in it.
 */
export function mayAdmit(entry: AdmissionCandidate): AdmissionCheck {
  if (entry.claimedAt !== null) {
    return { ok: false, reason: "That entry has already been claimed." };
  }
  if (entry.status === "CLAIMED") {
    return { ok: false, reason: "That entry has already been claimed." };
  }
  if (entry.status === "DECLINED") {
    return { ok: false, reason: "That entry was declined. Re-open it before admitting." };
  }
  return { ok: true };
}

export interface ClaimCandidate {
  readonly status: string;
  readonly claimedAt: Date | null;
  readonly tokenExpiresAt: Date | null;
}

/**
 * Single-use and expiring, checked in that order.
 *
 * A consumed token reports as consumed even after it expires, because "this was
 * already used" is the answer somebody needs when they click an old email twice
 * -- telling them it expired sends them to ask for a new one they do not need.
 */
export function mayClaim(entry: ClaimCandidate, now: Date): AdmissionCheck {
  if (entry.claimedAt !== null) {
    return { ok: false, reason: "That invitation has already been used." };
  }
  if (entry.status !== "INVITED") {
    return { ok: false, reason: "That invitation is no longer valid." };
  }
  if (entry.tokenExpiresAt === null) {
    // A row in INVITED with no expiry predates this column or was written by
    // hand. Refusing is the safe reading: an admission token with no expiry is
    // a permanent key to create organisations.
    return { ok: false, reason: "That invitation is no longer valid." };
  }
  if (entry.tokenExpiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "That invitation has expired. Ask for a new one." };
  }
  return { ok: true };
}
