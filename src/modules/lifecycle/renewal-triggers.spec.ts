import {
  EXPANSION_WINDOW_DAYS,
  MAX_TRIGGER_ATTEMPTS,
  RENEWAL_LEAD_DAYS,
  TRIGGER_RETRY_DAYS,
  decideTrigger,
  isChurnEvidence,
  renewalNextStep,
  renewalOpportunityName,
  type ExistingTrigger,
  type TriggerCandidate,
} from "./renewal-triggers";
import { AT_RISK_THRESHOLD as RISK_AT_RISK_THRESHOLD } from "./lifecycle-risk";

/**
 * The decider is the only judgement in this ticket, so it is the only thing
 * asserted here as a judgement. What it must never do is decide anything about
 * sending — that belongs to `outbound-eligibility.ts` and `send-guardrails.ts`,
 * and a test here that pinned a class or a hold would be the first sign this
 * file had started growing a second loop.
 *
 * Each case names the failure it prevents rather than restating the branch.
 */

const AS_OF = new Date("2026-08-27T09:00:00.000Z");

function candidate(over: Partial<TriggerCandidate> = {}): TriggerCandidate {
  return {
    status: "active",
    renewalOn: "2027-06-30",
    termStartedOn: "2026-06-30",
    riskScore: 0,
    healthStatus: "healthy",
    lastSignalAt: null,
    existing: null,
    asOf: AS_OF,
    ...over,
  };
}

function existing(over: Partial<ExistingTrigger> = {}): ExistingTrigger {
  return { hasOpportunity: true, attempts: 1, lastAttemptAt: null, holdPlaced: false, ...over };
}

describe("when a renewal conversation opens", () => {
  it("opens on the calendar exactly one lead window before the renewal", () => {
    // 2026-08-27 + 90 days = 2026-11-25. The boundary is inclusive, so a
    // renewal on that day is due and one day later is not: an exclusive bound
    // would leave every contract renewing exactly a quarter out unconsidered
    // until the following sweep, which on a weekly cron is a week of silence.
    const onTheDay = decideTrigger(candidate({ renewalOn: "2026-11-25" }));
    const oneDayLater = decideTrigger(candidate({ renewalOn: "2026-11-26" }));

    expect(onTheDay).toEqual({
      action: "open",
      kind: "renewal-due",
      dueOn: "2026-08-27",
    });
    expect(oneDayLater).toEqual({ action: "stand-down", reason: "not-due" });
  });

  it("dates the conversation to when the window opened, not to today", () => {
    /**
     * The failure: a sweep that has been ignoring a renewal for two months
     * reports it as due today, the loop's next-step grace treats it as fresh,
     * and a badly overdue renewal is indistinguishable from one that came up
     * this morning.
     */
    const decision = decideTrigger(candidate({ renewalOn: "2026-09-30" }));

    expect(decision).toEqual({
      action: "open",
      kind: "renewal-due",
      dueOn: "2026-07-02",
    });
  });

  it("still opens a renewal whose date has already passed", () => {
    /**
     * A term that reached its renewal date while still `active` is either
     * revenue nobody renewed or a book nobody maintains, and both are the most
     * urgent rows there are. A lead window with a floor would silently exclude
     * exactly those — the ones a renewal feature exists for.
     */
    const decision = decideTrigger(
      candidate({ renewalOn: "2026-07-01", termStartedOn: "2025-07-01" }),
    );

    expect(decision).toMatchObject({ action: "open", kind: "renewal-due", dueOn: "2026-04-02" });
  });

  it("never dates the conversation before the term it is about", () => {
    /**
     * A one-month contract renews 30 days after it starts, which is inside the
     * 90-day lead window: `renewal - 90` lands two months before the customer
     * bought anything. That date also violates
     * `chk_customer_lifecycle_triggers_dates`, so without the clamp every short
     * term throws a constraint violation on every sweep rather than opening a
     * renewal.
     */
    const decision = decideTrigger(
      candidate({ termStartedOn: "2026-08-01", renewalOn: "2026-09-01" }),
    );

    expect(decision).toEqual({ action: "open", kind: "renewal-due", dueOn: "2026-08-01" });
  });
});

describe("when the evidence overrules the calendar", () => {
  const FAR_OFF = { renewalOn: "2027-06-30", termStartedOn: "2026-06-30" };

  it("opens early on a risk score at the book's own at-risk threshold", () => {
    const decision = decideTrigger(
      candidate({ ...FAR_OFF, riskScore: RISK_AT_RISK_THRESHOLD, lastSignalAt: new Date("2026-08-20T00:00:00.000Z") }),
    );

    expect(decision).toEqual({ action: "open", kind: "churn-risk", dueOn: "2026-08-20" });
  });

  it("opens early on a critical health band and not on an at-risk one", () => {
    /**
     * The health model reports `at_risk` from 40, which on a four-input model
     * with two inputs missing is a resting state rather than an alarm. Firing on
     * it would open a quarter of the book early and make the lead window
     * meaningless — the early path would BE the ordinary path.
     */
    const critical = decideTrigger(candidate({ ...FAR_OFF, healthStatus: "critical" }));
    const atRisk = decideTrigger(candidate({ ...FAR_OFF, healthStatus: "at_risk" }));

    expect(critical).toMatchObject({ action: "open", kind: "churn-risk" });
    expect(atRisk).toEqual({ action: "stand-down", reason: "not-due" });
  });

  it("treats an unscored customer as evidence of nothing", () => {
    // Null health is "the model could not say", which is not "critical". A
    // trigger that read absence as alarm would open every customer of a tenant
    // that has not adopted the timeline — the same failure P5-08's
    // `no-source` reason exists to prevent, arriving from this side.
    expect(decideTrigger(candidate({ ...FAR_OFF, healthStatus: null }))).toEqual({
      action: "stand-down",
      reason: "not-due",
    });
  });

  it("dates an early conversation to when the evidence arrived", () => {
    const decision = decideTrigger(
      candidate({
        ...FAR_OFF,
        healthStatus: "critical",
        lastSignalAt: new Date("2026-08-11T22:30:00.000Z"),
      }),
    );

    expect(decision).toMatchObject({ dueOn: "2026-08-11" });
  });

  it("does not date a conversation into the future when a signal is", () => {
    /**
     * Clock skew, or a rep filing something they have already agreed. A due date
     * in the future is one the loop's next-step branch can never reach, so the
     * conversation would be opened and then never worked.
     */
    const decision = decideTrigger(
      candidate({
        ...FAR_OFF,
        healthStatus: "critical",
        lastSignalAt: new Date("2026-12-01T00:00:00.000Z"),
      }),
    );

    expect(decision).toMatchObject({ dueOn: "2026-08-27" });
  });

  it("prefers the calendar's reason when both would fire", () => {
    // Inside the window, a bad score is not why the conversation is opening —
    // it was opening anyway. Recording it as `churn-risk` would make the log
    // read as though the calendar had been overruled when it had not.
    const decision = decideTrigger(
      candidate({ renewalOn: "2026-09-30", riskScore: 95, healthStatus: "critical" }),
    );

    expect(decision).toMatchObject({ kind: "renewal-due" });
  });
});

describe("when it stands down", () => {
  it("chases nothing on a term that ended", () => {
    for (const status of ["churned", "cancelled"])
      expect(decideTrigger(candidate({ status, renewalOn: "2026-09-01" }))).toEqual({
        action: "stand-down",
        reason: "term-closed",
      });
  });

  it("reports an unparseable renewal date rather than guessing at one", () => {
    expect(decideTrigger(candidate({ renewalOn: "not-a-date" }))).toEqual({
      action: "stand-down",
      reason: "unusable-term",
    });
  });

  it("leaves a conversation alone once the loop has drafted for it", () => {
    /**
     * Once a hold exists the message is written and its window is running. A
     * re-offer would pay for a second draft and then collide with
     * `uniq_autonomy_holds_live_outbound` — money spent to earn a 409.
     */
    expect(
      decideTrigger(
        candidate({ renewalOn: "2026-09-30", existing: existing({ holdPlaced: true }) }),
      ),
    ).toEqual({ action: "stand-down", reason: "already-working" });
  });

  it("waits out the retry interval before asking the loop again", () => {
    const justBefore = new Date(AS_OF.getTime() - (TRIGGER_RETRY_DAYS * 86_400_000 - 1000));
    const justAfter = new Date(AS_OF.getTime() - TRIGGER_RETRY_DAYS * 86_400_000);

    expect(
      decideTrigger(candidate({ existing: existing({ lastAttemptAt: justBefore }) })),
    ).toEqual({ action: "stand-down", reason: "too-soon-to-reoffer" });
    expect(decideTrigger(candidate({ existing: existing({ lastAttemptAt: justAfter }) }))).toEqual({
      action: "reoffer",
    });
  });

  it("stops re-offering once the refusals are ones only a human can clear", () => {
    expect(
      decideTrigger(candidate({ existing: existing({ attempts: MAX_TRIGGER_ATTEMPTS }) })),
    ).toEqual({ action: "stand-down", reason: "attempts-exhausted" });
  });

  it("re-offers a term whose renewal is far off, because the trigger already fired", () => {
    /**
     * The candidate below would never OPEN — its renewal is a year away and its
     * scores are clean. It must still be re-offered: the reason it opened was
     * true when it opened, and a trigger that fell out of the sweep the moment
     * its evidence cooled would strand every conversation the loop declined
     * once.
     */
    expect(decideTrigger(candidate({ existing: existing() }))).toEqual({ action: "reoffer" });
  });
});

describe("the churn evidence rule", () => {
  it("takes either source, because a customer can be critical on one and quiet on the other", () => {
    expect(isChurnEvidence({ riskScore: RISK_AT_RISK_THRESHOLD, healthStatus: "healthy" })).toBe(true);
    expect(isChurnEvidence({ riskScore: 0, healthStatus: "critical" })).toBe(true);
    expect(isChurnEvidence({ riskScore: RISK_AT_RISK_THRESHOLD - 1, healthStatus: "healthy" })).toBe(
      false,
    );
  });
});

describe("what the opportunity says", () => {
  it("leads with the word Renewal, so the forecast is not distorted", () => {
    /**
     * The row lands in a rep's deal list beside new business. A renewal that
     * reads as new business inflates every forecast that counts open pipeline.
     */
    expect(renewalOpportunityName("Northwind Trading", "2027-06-30")).toBe(
      "Renewal — Northwind Trading (2027-06-30)",
    );
  });

  it("never produces an empty name for a customer with no recorded one", () => {
    expect(renewalOpportunityName("   ", "2027-06-30")).toBe("Renewal — Customer (2027-06-30)");
  });

  it("keeps the next step inside the cap the prompt applies", () => {
    /**
     * `outbound.service.ts` caps `agreedNextStep` at 200 characters before the
     * model sees it. A longer sentence here would reach the model truncated
     * mid-word, which is a worse instruction than a shorter one.
     */
    for (const kind of ["renewal-due", "churn-risk"] as const)
      expect(renewalNextStep(kind, "2027-06-30").length).toBeLessThanOrEqual(200);
  });

  it("asks a different question when the renewal was opened early", () => {
    expect(renewalNextStep("churn-risk", "2027-06-30")).toContain("churn risk");
    expect(renewalNextStep("renewal-due", "2027-06-30")).not.toContain("churn risk");
  });

  it("quotes no money, because a paraphrased price cannot be recalled", () => {
    // The drafting model paraphrases what it is given. A contract value in the
    // next step is a number it may restate wrongly in a renewal mail.
    for (const kind of ["renewal-due", "churn-risk"] as const)
      expect(renewalNextStep(kind, "2027-06-30")).not.toMatch(/\d[\d,]*\.\d\d|\b\d{4,}\b(?!-)/);
  });
});

describe("the lead window's own constants", () => {
  it("is a quarter, and the retry interval is shorter than it by an order", () => {
    /**
     * Not a restatement of the numbers: what matters is the relation. A retry
     * interval anywhere near the lead window would give a declined conversation
     * one or two chances before the renewal arrived, and the whole point of
     * re-offering is that the loop's refusals expire.
     */
    expect(RENEWAL_LEAD_DAYS).toBeGreaterThan(TRIGGER_RETRY_DAYS * MAX_TRIGGER_ATTEMPTS);
  });
});

/**
 * CRM-P2-07. The third reason to open a conversation, and the one the book was
 * missing: the customer said they wanted more.
 *
 * `expansion-interest` has been a first-class lifecycle signal since the risk
 * model shipped — worth -20 against churn — and nothing ever opened a
 * conversation off it. The product could tell you a customer had asked for more
 * and had no way to act on it until their renewal came round, which for an
 * annual contract is up to a year of silence after somebody raised their hand.
 */
describe("when an expansion conversation opens", () => {
  /** Far outside the renewal window, so nothing else is competing for the account. */
  const quiet = { renewalOn: "2027-06-30", healthStatus: "healthy", riskScore: 0 };
  const daysAgo = (days: number) => new Date(AS_OF.getTime() - days * 86_400_000);

  it("opens on a recent interest from a healthy customer", () => {
    const decision = decideTrigger(
      candidate({ ...quiet, expansionSignalAt: daysAgo(3) }),
    );

    expect(decision).toEqual({
      action: "open",
      kind: "expansion-ready",
      /** The day they said it, not the day the sweep noticed. */
      dueOn: "2026-08-24",
    });
  });

  it("does nothing for a customer who has not asked", () => {
    /** The ordinary case, and it must stay ordinary: most customers have no signal. */
    expect(decideTrigger(candidate(quiet))).toEqual({
      action: "stand-down",
      reason: "not-due",
    });
  });

  it("lets an old interest go rather than acting on it months later", () => {
    /**
     * A customer who mentioned a second team in March has not been waiting since
     * March. Opening that conversation in June reads as nobody having listened.
     */
    const stale = decideTrigger(
      candidate({ ...quiet, expansionSignalAt: daysAgo(EXPANSION_WINDOW_DAYS + 1) }),
    );
    expect(stale).toEqual({ action: "stand-down", reason: "not-due" });

    const fresh = decideTrigger(
      candidate({ ...quiet, expansionSignalAt: daysAgo(EXPANSION_WINDOW_DAYS) }),
    );
    expect(fresh).toMatchObject({ action: "open", kind: "expansion-ready" });
  });

  it("answers a struggling customer's interest as churn, not as an opportunity", () => {
    /**
     * The ordering that matters most here. A customer who is critical and has
     * mentioned wanting more is telling you what is at RISK, not what is on
     * offer, and selling into that is the worst message in the product.
     */
    const decision = decideTrigger(
      candidate({
        ...quiet,
        healthStatus: "critical",
        expansionSignalAt: daysAgo(2),
      }),
    );

    expect(decision).toMatchObject({ action: "open", kind: "churn-risk" });
  });

  it("defers to the risk score when it disagrees with the health band", () => {
    /**
     * The two are built from different evidence and can disagree; when they do
     * the pessimistic one wins. A green health band on a customer whose contract
     * is full of escalations is not permission to upsell them.
     */
    const decision = decideTrigger(
      candidate({
        ...quiet,
        riskScore: RISK_AT_RISK_THRESHOLD,
        expansionSignalAt: daysAgo(2),
      }),
    );

    expect(decision).toMatchObject({ action: "open", kind: "churn-risk" });
  });

  it("says nothing when the model could not score the customer", () => {
    /** Selling more into a customer nobody can score is a person's decision. */
    expect(
      decideTrigger(candidate({ ...quiet, healthStatus: null, expansionSignalAt: daysAgo(2) })),
    ).toEqual({ action: "stand-down", reason: "not-due" });
  });

  it("stays out of the way of a renewal that is already due", () => {
    /**
     * Inside the lead window the renewal is the conversation, and expansion is
     * part of it. Two messages about the same account in the same fortnight is
     * two where the customer expected none.
     */
    const decision = decideTrigger(
      candidate({
        ...quiet,
        renewalOn: "2026-10-01",
        expansionSignalAt: daysAgo(2),
      }),
    );

    expect(decision).toMatchObject({ action: "open", kind: "renewal-due" });
  });

  it("does not date the conversation into the future on a skewed signal", () => {
    /** Clock skew, or a rep filing something they have already agreed. */
    const decision = decideTrigger(
      candidate({ ...quiet, expansionSignalAt: new Date(AS_OF.getTime() + 86_400_000 * 5) }),
    );

    expect(decision).toMatchObject({ action: "open", kind: "expansion-ready", dueOn: "2026-08-27" });
  });

  it("never opens a second conversation while one is already running", () => {
    /**
     * Idempotency is resolved before any freshness question, so an expansion
     * signal on an account the loop is already working is not a new trigger.
     */
    expect(
      decideTrigger(
        candidate({
          ...quiet,
          expansionSignalAt: daysAgo(1),
          existing: existing({ holdPlaced: true }),
        }),
      ),
    ).toEqual({ action: "stand-down", reason: "already-working" });
  });
});

describe("what an expansion opportunity is called, and asks for", () => {
  it("does not call an expansion a renewal", () => {
    /**
     * The row lands in a rep's deal list beside ordinary new business, and the
     * distortion runs both ways: a renewal that reads as new business inflates
     * open pipeline, and an expansion that reads as a renewal hides revenue that
     * genuinely is new.
     */
    expect(renewalOpportunityName("Kavya Textiles", "2027-06-30", "expansion-ready")).toBe(
      "Expansion — Kavya Textiles",
    );
    expect(renewalOpportunityName("Kavya Textiles", "2027-06-30", "renewal-due")).toContain(
      "Renewal —",
    );
  });

  it("does not mention the renewal date in an expansion's next step", () => {
    /**
     * Bringing up the contract date in reply to "we might need another team"
     * turns an opening into a negotiation. The sentence is what the drafting
     * model is told was agreed, so what it omits matters as much as what it says.
     */
    const step = renewalNextStep("expansion-ready", "2027-06-30");
    expect(step).not.toContain("2027-06-30");
    expect(step).not.toMatch(/renew/i);
    expect(step).toMatch(/wanting more/i);
  });
});
