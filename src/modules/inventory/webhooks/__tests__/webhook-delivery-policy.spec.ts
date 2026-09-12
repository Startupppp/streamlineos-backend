import {
  WEBHOOK_ALERT_AFTER_DEAD_LETTERS,
  WEBHOOK_DISABLE_AFTER_DEAD_LETTERS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_MINIMUM_WINDOW_MS,
  WEBHOOK_RETRY_SCHEDULE_MS,
  WEBHOOK_RETRY_WINDOW_MS,
  planWebhookAttempt,
  planWebhookHealth,
} from "../webhook-delivery-policy";

describe("inventory webhook delivery policy", () => {
  const now = new Date("2026-08-29T00:00:00.000Z");

  it("keeps a delivery retryable for at least 24 hours", () => {
    // The work order's floor, asserted against the written schedule rather than
    // re-derived from it — shortening a delay has to fail here, not silently
    // shrink the window a customer's outage is measured against.
    expect(WEBHOOK_RETRY_WINDOW_MS).toBeGreaterThanOrEqual(WEBHOOK_RETRY_MINIMUM_WINDOW_MS);
  });

  it("never schedules a retry sooner than the previous one", () => {
    const regressions = WEBHOOK_RETRY_SCHEDULE_MS.filter(
      (delay, i) => i > 0 && delay < (WEBHOOK_RETRY_SCHEDULE_MS[i - 1] ?? 0),
    );
    expect(regressions).toEqual([]);
  });

  it("walks the schedule in order and then dead-letters", () => {
    const scheduled: number[] = [];
    let attempts = 0;
    let plan = planWebhookAttempt({ attempts, ok: false, now });

    while (plan.status === "PENDING") {
      expect(plan.nextAttemptAt).not.toBeNull();
      scheduled.push(plan.nextAttemptAt!.getTime() - now.getTime());
      attempts = plan.attempts;
      plan = planWebhookAttempt({ attempts, ok: false, now });
    }

    expect(scheduled).toEqual([...WEBHOOK_RETRY_SCHEDULE_MS]);
    expect(plan).toMatchObject({
      status: "FAILED",
      attempts: WEBHOOK_MAX_ATTEMPTS,
      nextAttemptAt: null,
      deadLetteredAt: now,
    });
  });

  it("marks a success delivered and stops scheduling", () => {
    expect(planWebhookAttempt({ attempts: 3, ok: true, now })).toEqual({
      status: "DELIVERED",
      attempts: 4,
      nextAttemptAt: null,
      deliveredAt: now,
      deadLetteredAt: null,
    });
  });

  it("dead-letters a terminal failure immediately instead of burning the schedule", () => {
    // A deleted or disabled subscription is not going to start accepting on the
    // ninth attempt; retrying it for a day is 10 pointless outbound requests.
    expect(planWebhookAttempt({ attempts: 0, ok: false, now, terminal: true })).toMatchObject({
      status: "FAILED",
      attempts: 1,
      deadLetteredAt: now,
    });
  });

  it("alerts strictly before it disables", () => {
    expect(WEBHOOK_ALERT_AFTER_DEAD_LETTERS).toBeLessThan(WEBHOOK_DISABLE_AFTER_DEAD_LETTERS);

    // Walk a healthy webhook through consecutive dead letters and record when each
    // decision first becomes true. The disable must never be reachable on or
    // before the alert.
    let alertedAt: Date | null = null;
    let isActive = true;
    let firstAlert: number | null = null;
    let firstDisable: number | null = null;

    for (let deadLetters = 1; deadLetters <= WEBHOOK_DISABLE_AFTER_DEAD_LETTERS + 2; deadLetters++) {
      const plan = planWebhookHealth({ consecutiveFailures: deadLetters, alertedAt, isActive });
      if (plan.alert) {
        firstAlert ??= deadLetters;
        alertedAt = new Date();
      }
      if (plan.disable) {
        firstDisable ??= deadLetters;
        isActive = false;
      }
    }

    expect(firstAlert).toBe(WEBHOOK_ALERT_AFTER_DEAD_LETTERS);
    expect(firstDisable).toBe(WEBHOOK_DISABLE_AFTER_DEAD_LETTERS);
    expect(firstAlert!).toBeLessThan(firstDisable!);
  });

  it("alerts once per streak, not on every dead letter", () => {
    expect(
      planWebhookHealth({ consecutiveFailures: 2, alertedAt: new Date(), isActive: true }).alert,
    ).toBe(false);
  });

  it("does not re-disable a webhook that is already off", () => {
    expect(
      planWebhookHealth({
        consecutiveFailures: WEBHOOK_DISABLE_AFTER_DEAD_LETTERS + 1,
        alertedAt: new Date(),
        isActive: false,
      }).disable,
    ).toBe(false);
  });
});
