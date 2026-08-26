import type { DecisionKind, DecisionOutcome } from "../../db/schema/crm/autonomous-decisions";

/**
 * Whether an autonomous writer may create a record, and what to record if not.
 *
 * Phase 3 ticket 07's remaining half. AI *spend* was already enforced -- the
 * gateway refuses on an unsuccessful credit reservation -- but autonomous
 * *record creation* was not. An inbound email stream could create parties
 * without limit regardless of the tenant's plan, because every limit written
 * before the autonomy work assumed a human on the other end of the request.
 *
 * Two things matter about the refusal, and they pull in opposite directions:
 *
 *   **The limit must bite.** A cap that autonomous writers can walk past is not
 *   a cap; it is a cap on the people who use the product carefully.
 *
 *   **The communication must not vanish.** Refusing to record that an email
 *   arrived, because a plan limit was reached, loses a customer's message. The
 *   receipt is kept and the *derived record* is what is refused -- so nothing is
 *   lost, it is unattributed and visible, and a person can act on it.
 *
 * So a refusal is a decision with an outcome, not an exception that unwinds the
 * ingest. It appears in the review feed beside every other autonomous act, which
 * is where a tenant discovers they have outgrown their plan.
 */

export type WriteVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly limitKey: string;
      readonly limit: number;
      readonly current: number;
      /** What to record, so the refusal is visible rather than swallowed. */
      readonly decision: {
        readonly kind: DecisionKind;
        readonly outcome: DecisionOutcome;
        readonly summary: string;
        readonly decision: Record<string, unknown>;
      };
    };

export interface WriteRequest {
  readonly kind: DecisionKind;
  readonly limitKey: string;
  /** The plan's allowance. `null` is the catalogue's word for unlimited. */
  readonly limit: number | null;
  readonly current: number;
  /** How many rows this write would add. */
  readonly adding?: number;
}

/**
 * What the plan catalogue means by "no limit".
 *
 * `PLAN_LIMITS` writes it as `null`. This guard originally accepted only a
 * negative number, which is a convention the platform does not use anywhere --
 * so an ENTERPRISE plan arrived with `null`, failed `current + 1 <= null`, and
 * every autonomous write on the most expensive plan we sell would have been
 * refused. Reading it as zero fails the same way.
 *
 * The negative case is kept because it costs nothing and because a caller that
 * computes a remaining allowance can legitimately arrive here below zero.
 */
export function isUnlimited(limit: number | null): boolean {
  return limit === null || limit < 0;
}

export function evaluateAutonomousWrite(request: WriteRequest): WriteVerdict {
  const adding = request.adding ?? 1;

  const limit = request.limit;
  if (isUnlimited(limit)) return { allowed: true };
  // `isUnlimited` has ruled out null; this narrows it for the compiler.
  if (limit === null) return { allowed: true };
  if (request.current + adding <= limit) return { allowed: true };

  const reason =
    `The plan allows ${limit} ${request.limitKey}, and this organisation has ` +
    `${request.current}. The system did not create ${adding === 1 ? "another" : `${adding} more`}.`;

  return {
    allowed: false,
    reason,
    limitKey: request.limitKey,
    limit,
    current: request.current,
    decision: {
      kind: request.kind,
      // Skipped, not failed. Nothing went wrong: the system declined on purpose,
      // and a tenant reading the feed should see a decision rather than an error
      // they might report as a bug.
      outcome: "skipped",
      summary: reason,
      decision: {
        refusedBy: "plan-limit",
        limitKey: request.limitKey,
        limit,
        current: request.current,
        adding,
      },
    },
  };
}

/**
 * The message a person sees, which has to say what to do about it.
 *
 * "Limit reached" tells somebody they have a problem. Naming the limit and the
 * plan tells them how to stop having it.
 */
export function upgradePrompt(verdict: Extract<WriteVerdict, { allowed: false }>): string {
  return (
    `${verdict.reason} Records already in the system are unaffected; ` +
    `raising the plan's ${verdict.limitKey} limit resumes this automatically.`
  );
}
