/**
 * The second gate, in front of the one every outbound already passes.
 *
 * Cold outbound is not a louder follow-up. Its failure mode is different in
 * kind: a bad follow-up annoys one customer and a bad cold campaign gets the
 * sending domain listed, which takes every other tenant's transactional mail
 * down with it. That asymmetry is why this is a separate track with separate
 * gating rather than a class the existing loop is allowed to emit.
 *
 * Every rule here fails closed and none of them is a tenant's to set. Off is
 * the default — not "off until configured", off until somebody with the
 * authority to accept the risk turns it on for that tenant specifically — and a
 * tenant that has not done that cannot send one by accident, because the first
 * clause of this function is the enablement flag.
 */

export type ColdDomainPurpose = "transactional" | "cold";

export interface ColdSendingDomain {
  readonly domain: string;
  readonly purpose: ColdDomainPurpose;
  readonly verifiedAt: Date | null;
  readonly warmupStartedAt: Date | null;
}

export interface ColdTrackFacts {
  readonly now: Date;
  /** Explicit per-tenant enablement. Absent means off. */
  readonly enabled: boolean;
  /** Set by the automatic pause, cleared only by a person. */
  readonly pausedAt: Date | null;
  /** The domain the cold track would send from, if one is registered. */
  readonly domain: ColdSendingDomain | null;
  /** What the tenant's ordinary mail goes out on, so this cannot borrow it. */
  readonly transactionalDomain: string | null;
  /** Cold sends already made today on this domain. */
  readonly sentToday: number;
  /** Cold sends over the measurement window, and how they landed. */
  readonly recentSends: number;
  readonly recentBounces: number;
  readonly recentComplaints: number;
}

export type ColdBlockReason =
  | "not-enabled"
  | "paused"
  | "no-cold-domain"
  | "domain-not-verified"
  | "warmup-not-started"
  | "borrows-transactional-reputation"
  | "daily-cap-reached"
  | "bounce-rate"
  | "complaint-rate";

export type ColdVerdict =
  | { readonly allow: true; readonly dailyCap: number; readonly warmupDay: number }
  | {
      readonly allow: false;
      readonly reason: ColdBlockReason;
      /** Whether this refusal is also grounds to stop the track outright. */
      readonly pauseTrack: boolean;
    };

/**
 * What the domain may send on each day of its warm-up, in order.
 *
 * A ramp rather than a cap, because reputation is built by a rising volume of
 * mail that gets engaged with, and a domain that sends two thousand messages on
 * its first day is not a new domain to a receiving provider, it is a new
 * spammer. The last figure is the ceiling and every day past the schedule holds
 * there — an unbounded ramp would eventually make the ramp meaningless.
 */
export const COLD_RAMP_SCHEDULE: readonly number[] = [
  20, 40, 80, 120, 180, 250, 350, 500, 700, 900, 1200, 1500, 2000,
];

/** Above this share of bounces the track stops itself. */
export const COLD_BOUNCE_RATE_CEILING = 0.02;
/** Above this share of complaints it stops itself. Complaints cost far more. */
export const COLD_COMPLAINT_RATE_CEILING = 0.001;

/**
 * Below this many sends the rates are not evidence.
 *
 * One bounce in the first three messages is a 33% bounce rate and means
 * nothing. Judging it would pause every tenant on their first afternoon, and a
 * pause that fires on noise teaches an operator to clear it without reading.
 */
export const COLD_MIN_VOLUME_FOR_RATES = 50;

const DAY_MS = 86_400_000;

/** Which day of the warm-up a domain is on. Day one is the day it started. */
export function warmupDay(warmupStartedAt: Date, now: Date): number {
  const elapsed = now.getTime() - warmupStartedAt.getTime();
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / DAY_MS) + 1;
}

/** How much that day may send. Day zero — a warm-up dated in the future — sends nothing. */
export function rampCapFor(day: number): number {
  if (day < 1) return 0;
  const index = Math.min(day, COLD_RAMP_SCHEDULE.length) - 1;
  return COLD_RAMP_SCHEDULE[index] ?? 0;
}

/**
 * A domain is the same domain regardless of case or a stray leading dot.
 *
 * Compared rather than trusted because "cannot borrow the transactional
 * reputation" is a claim about the sending domain a receiving provider sees,
 * and `Mail.Acme.com` and `mail.acme.com` are one domain to them.
 */
export function sameDomain(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const normalise = (value: string): string => value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  return normalise(a) === normalise(b);
}

/**
 * A subdomain of the transactional domain shares its reputation too.
 *
 * Receiving providers reputation-score the organisational domain as well as the
 * exact host, so `cold.acme.com` off the back of `acme.com` is precisely the
 * borrowing this criterion forbids — and it is the shape somebody sets up in
 * good faith while believing they have separated the two.
 */
export function sharesReputation(candidate: string | null, transactional: string | null): boolean {
  if (!candidate || !transactional) return false;
  if (sameDomain(candidate, transactional)) return true;

  const strip = (value: string): string => value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  const cold = strip(candidate);
  const warm = strip(transactional);

  // Compare on the registrable-looking tail: the last two labels of each. This
  // is deliberately coarse — a false positive refuses a send, which is the
  // direction this whole file errs in.
  const tail = (value: string): string => value.split(".").slice(-2).join(".");
  return tail(cold) === tail(warm);
}

/**
 * Whether a cold message may leave right now, and what it may not exceed.
 *
 * The order runs from the gates that are about permission down to the ones
 * about volume, so a tenant who never turned this on is told that rather than
 * being told their domain is unwarmed — which would read as a configuration
 * problem and invite somebody to solve it.
 */
export function evaluateColdGate(facts: ColdTrackFacts): ColdVerdict {
  if (!facts.enabled) return { allow: false, reason: "not-enabled", pauseTrack: false };
  if (facts.pausedAt) return { allow: false, reason: "paused", pauseTrack: false };

  const domain = facts.domain;
  if (!domain || domain.purpose !== "cold")
    return { allow: false, reason: "no-cold-domain", pauseTrack: false };

  if (!domain.verifiedAt)
    return { allow: false, reason: "domain-not-verified", pauseTrack: false };

  if (sharesReputation(domain.domain, facts.transactionalDomain))
    return { allow: false, reason: "borrows-transactional-reputation", pauseTrack: false };

  if (!domain.warmupStartedAt)
    return { allow: false, reason: "warmup-not-started", pauseTrack: false };

  /**
   * Rates before the daily cap.
   *
   * A domain that is bouncing has to stop whether or not it has room left
   * today, and reporting "daily cap reached" to a domain that is actually
   * burning would be the most misleading answer available.
   */
  if (facts.recentSends >= COLD_MIN_VOLUME_FOR_RATES) {
    if (facts.recentBounces / facts.recentSends > COLD_BOUNCE_RATE_CEILING)
      return { allow: false, reason: "bounce-rate", pauseTrack: true };

    if (facts.recentComplaints / facts.recentSends > COLD_COMPLAINT_RATE_CEILING)
      return { allow: false, reason: "complaint-rate", pauseTrack: true };
  }

  const day = warmupDay(domain.warmupStartedAt, facts.now);
  const dailyCap = rampCapFor(day);

  if (day < 1) return { allow: false, reason: "warmup-not-started", pauseTrack: false };
  if (facts.sentToday >= dailyCap)
    return { allow: false, reason: "daily-cap-reached", pauseTrack: false };

  return { allow: true, dailyCap, warmupDay: day };
}

export function coldBlockSummary(reason: ColdBlockReason): string {
  switch (reason) {
    case "not-enabled":
      return "Cold outbound is not enabled for this organisation.";
    case "paused":
      return "The cold track is paused and will not send until somebody clears it.";
    case "no-cold-domain":
      return "No warmed sending domain is registered for cold outbound.";
    case "domain-not-verified":
      return "The cold sending domain has not been verified.";
    case "warmup-not-started":
      return "The cold sending domain has not started its warm-up.";
    case "borrows-transactional-reputation":
      return "That domain shares reputation with the transactional sender and may not be used for cold outbound.";
    case "daily-cap-reached":
      return "The warm-up ramp's cap for today has been reached.";
    case "bounce-rate":
      return "Bounces crossed the ceiling — the cold track stopped itself.";
    case "complaint-rate":
      return "Complaints crossed the ceiling — the cold track stopped itself.";
  }
}
