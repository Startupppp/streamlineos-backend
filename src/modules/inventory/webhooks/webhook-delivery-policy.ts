/**
 * E7 — the delivery policy, kept as data so a test can assert the schedule rather
 * than re-derive it from a formula.
 *
 * The work order asks for "retry ≥ 24h". A doubling formula reaches 24h only by
 * accident of where the ceiling lands, and the ceiling is exactly the part that
 * gets tuned later, so the schedule is written out and the 24h floor is asserted
 * against the written total (`webhook-delivery-policy.spec.ts`). Editing a delay
 * that drops the sum below a day fails that test instead of quietly shortening
 * the window a customer's outage is measured against.
 */

/**
 * Delay before each *retry*, in order. Attempt 1 is immediate, so the first entry
 * is the gap between attempt 1 and attempt 2.
 *
 * Front-loaded, then flat: almost every real failure is a deploy or a restart and
 * clears inside the first hour, and an endpoint still refusing after four hours
 * is an outage that six-hourly polling will not fix any faster.
 */
export const WEBHOOK_RETRY_SCHEDULE_MS: readonly number[] = [
  1 * 60_000, //        1m   cumulative 1m
  5 * 60_000, //        5m               6m
  15 * 60_000, //      15m              21m
  30 * 60_000, //      30m              51m
  60 * 60_000, //       1h            1h51m
  2 * 60 * 60_000, //   2h            3h51m
  4 * 60 * 60_000, //   4h            7h51m
  6 * 60 * 60_000, //   6h           13h51m
  6 * 60 * 60_000, //   6h           19h51m
  6 * 60 * 60_000, //   6h           25h51m
];

/** Attempt 1 plus one per scheduled retry. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_SCHEDULE_MS.length + 1;

/** How long an event stays retryable, from first attempt to dead-letter. */
export const WEBHOOK_RETRY_WINDOW_MS = WEBHOOK_RETRY_SCHEDULE_MS.reduce((a, b) => a + b, 0);

export const WEBHOOK_RETRY_MINIMUM_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Dead letters since the last success, not failed attempts.
 *
 * One dead letter already means this URL refused every attempt across the whole
 * retry window above, so it is a strong signal on its own and worth telling
 * somebody about immediately. Three is a deliberately conservative bar for
 * silently switching a customer's integration off, and the gap between the two
 * is what guarantees an operator hears about the problem long before the product
 * makes a decision for them.
 */
export const WEBHOOK_ALERT_AFTER_DEAD_LETTERS = 1;
export const WEBHOOK_DISABLE_AFTER_DEAD_LETTERS = 3;

/** How long a claimed event may be held by a worker before another may re-claim it. */
export const WEBHOOK_DELIVERY_LEASE_MS = 60_000;

/** Delivery HTTP timeout. Bounded well under the lease so a hung endpoint cannot outlive its claim. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

/** Events claimed per worker tick, across all organisations. */
export const WEBHOOK_DELIVERY_BATCH_SIZE = 50;

/**
 * Delay before the attempt that follows `attempts` completed attempts, or `null`
 * when the schedule is exhausted and the event must be dead-lettered instead.
 */
export function nextWebhookAttemptDelayMs(attempts: number): number | null {
  if (attempts < 1) return 0;
  return WEBHOOK_RETRY_SCHEDULE_MS[attempts - 1] ?? null;
}

export function shouldDeadLetterWebhookEvent(attempts: number): boolean {
  return attempts >= WEBHOOK_MAX_ATTEMPTS;
}

export function shouldAlertForWebhook(deadLetters: number): boolean {
  return deadLetters >= WEBHOOK_ALERT_AFTER_DEAD_LETTERS;
}

export function shouldDisableWebhook(deadLetters: number): boolean {
  return deadLetters >= WEBHOOK_DISABLE_AFTER_DEAD_LETTERS;
}

export interface WebhookAttemptPlan {
  readonly status: "PENDING" | "DELIVERED" | "FAILED";
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly deadLetteredAt: Date | null;
}

/**
 * The next state of one delivery row, as a value.
 *
 * Pure and separate from the worker because this is the part a reader has to be
 * able to check: that a failure reschedules rather than terminating, that the
 * schedule is walked in order, and that the row stops being retryable at exactly
 * the point the schedule runs out — none of which is legible when it is spread
 * across the branches of a method that is also doing HTTP and SQL.
 */
export function planWebhookAttempt(input: {
  readonly attempts: number;
  readonly ok: boolean;
  readonly now: Date;
  /** A failure that will never succeed on a later attempt (the subscription is gone). */
  readonly terminal?: boolean;
}): WebhookAttemptPlan {
  const attempts = input.attempts + 1;

  if (input.ok) {
    return {
      status: "DELIVERED",
      attempts,
      nextAttemptAt: null,
      deliveredAt: input.now,
      deadLetteredAt: null,
    };
  }

  const delay = input.terminal ? null : nextWebhookAttemptDelayMs(attempts);
  if (delay === null || shouldDeadLetterWebhookEvent(attempts)) {
    return {
      status: "FAILED",
      attempts,
      nextAttemptAt: null,
      deliveredAt: null,
      deadLetteredAt: input.now,
    };
  }

  return {
    status: "PENDING",
    attempts,
    nextAttemptAt: new Date(input.now.getTime() + delay),
    deliveredAt: null,
    deadLetteredAt: null,
  };
}

export interface WebhookHealthPlan {
  readonly consecutiveFailures: number;
  readonly alert: boolean;
  readonly disable: boolean;
}

/**
 * What a dead letter does to the subscription's health.
 *
 * `alert` is gated on `alreadyAlerted` so a streak alerts once rather than on
 * every subsequent dead letter, and `disable` is gated on the webhook still being
 * active so a re-run cannot re-audit a disable that already happened. Because the
 * alert threshold is strictly lower than the disable threshold, `disable` is
 * unreachable from a healthy webhook without `alert` having been true on an
 * earlier call — the ordering is a property of the thresholds, not of the order
 * the caller happens to run its statements in.
 */
export function planWebhookHealth(input: {
  readonly consecutiveFailures: number;
  readonly alertedAt: Date | null;
  readonly isActive: boolean;
}): WebhookHealthPlan {
  const consecutiveFailures = input.consecutiveFailures;
  return {
    consecutiveFailures,
    alert: shouldAlertForWebhook(consecutiveFailures) && input.alertedAt === null,
    disable: shouldDisableWebhook(consecutiveFailures) && input.isActive,
  };
}
