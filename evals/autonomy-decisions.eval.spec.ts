import { EVAL_ACCEPTANCE, meetsGate, runEval } from "./ai-eval-runner";
import {
  OUTBOUND_DECISION_DATASET,
  RISK_BAND_DATASET,
  type OutboundEvalCase,
  type RiskEvalCase,
} from "./datasets/autonomy-decisions.dataset";
import {
  judgeOutbound,
  type OutboundVerdict,
} from "../src/modules/autonomy/outbound-eligibility";
import { riskBand, riskScore } from "../src/modules/lifecycle/lifecycle-risk";
import { mayRepair, type RepairPermission } from "../src/modules/autonomy/repair-classes";

/**
 * CRM-P2-11. A regression gate on the three CRM decisions nobody is asked about.
 *
 * The other eval suites in this directory measure a model. This one measures
 * code, and that is deliberate rather than a shortcut: the outbound judge, the
 * risk score and the repair policy are pure functions that decide, without a
 * person in the loop, whether to write to a customer, whether their contract is
 * in trouble, and whether to rewrite a field on their record. A prompt change
 * cannot regress them; a refactor can, and outside their own unit tests nothing
 * would notice — which is exactly the gap an eval gate is for.
 *
 * The corpus is deliberately small and every case names the mistake it
 * prevents. A large sample would say something about accuracy; these functions
 * are not approximations, so what is wanted is the set of situations that must
 * never come out the other way.
 */

describe("the outbound judge, gated on what a wrong answer costs", () => {
  it("never writes where writing would be unrecoverable", async () => {
    const report = await runEval<OutboundEvalCase, OutboundVerdict>(
      OUTBOUND_DECISION_DATASET.map((entry) => ({ name: entry.name, input: entry.input })),
      async (input) => judgeOutbound(input.snapshot),
      [
        {
          /**
           * Zero tolerance, and scoped to the cases that deserve it. Writing to
           * somebody who replied this morning, who is owed a reply, whose deal
           * closed, who has no address, or who the system wrote to on Tuesday
           * is not a missed opportunity — it is a message that cannot be
           * recalled and that a customer reads as nobody paying attention.
           */
          name: "OUTBOUND_NO_HARMFUL_SEND_RATE",
          check: (verdict, input) => (input.harmIfWritten ? verdict.act === false : true),
        },
        {
          /** The recoverable half: a nudge nobody sent costs a follow-up. */
          name: "OUTBOUND_ACT_RECALL",
          check: (verdict, input) => verdict.act === input.shouldAct,
        },
        {
          /**
           * The class is the message. A check-in sent where a nudge was due
           * reads as a system that has not been following the deal.
           */
          name: "OUTBOUND_CLASS_CORRECT_RATE",
          check: (verdict, input) =>
            !input.shouldAct || !verdict.act
              ? !input.shouldAct
              : verdict.outboundClass === input.outboundClass,
        },
      ],
    );

    expect(report.total).toBe(OUTBOUND_DECISION_DATASET.length);
    expect(
      meetsGate(report, {
        OUTBOUND_NO_HARMFUL_SEND_RATE: EVAL_ACCEPTANCE.OUTBOUND_NO_HARMFUL_SEND_RATE,
        OUTBOUND_ACT_RECALL: EVAL_ACCEPTANCE.OUTBOUND_ACT_RECALL,
        OUTBOUND_CLASS_CORRECT_RATE: EVAL_ACCEPTANCE.OUTBOUND_CLASS_CORRECT_RATE,
      }),
    ).toBe(true);
  });

  it("has cases on both sides, so a gate of 1.0 means something", async () => {
    /**
     * The anti-vacuity floor. A corpus of nothing but refusals would score a
     * perfect no-harmful-send rate from a judge that never writes at all, and
     * one of nothing but sends would score perfect recall from a judge that
     * always does.
     */
    const acts = OUTBOUND_DECISION_DATASET.filter((entry) => entry.input.shouldAct);
    const refusals = OUTBOUND_DECISION_DATASET.filter((entry) => !entry.input.shouldAct);
    const harmful = OUTBOUND_DECISION_DATASET.filter((entry) => entry.input.harmIfWritten);

    expect(acts.length).toBeGreaterThanOrEqual(4);
    expect(refusals.length).toBeGreaterThanOrEqual(4);
    expect(harmful.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the risk band, gated on false calm", () => {
  it("never reads a contract in trouble as fine", async () => {
    const report = await runEval<RiskEvalCase, string>(
      RISK_BAND_DATASET.map((entry) => ({ name: entry.name, input: entry.input })),
      async (input) =>
        riskBand(
          riskScore({
            signals: input.signals,
            renewalOn: input.renewalOn,
            status: input.status,
            asOf: input.asOf,
          }),
        ),
      [
        {
          /**
           * The asymmetric one. A book that calls a departing champion healthy
           * is a renewal nobody prepares for, discovered in the month it
           * expires; reading a fine account as worried costs a rep one glance.
           */
          name: "RISK_NO_FALSE_CALM_RATE",
          check: (band, input) => (input.falseCalmIsHarm ? band !== "healthy" : true),
        },
        { name: "RISK_BAND_EXACT_RATE", check: (band, input) => band === input.expectedBand },
      ],
    );

    expect(report.total).toBe(RISK_BAND_DATASET.length);
    expect(
      meetsGate(report, {
        RISK_NO_FALSE_CALM_RATE: EVAL_ACCEPTANCE.RISK_NO_FALSE_CALM_RATE,
        RISK_BAND_EXACT_RATE: EVAL_ACCEPTANCE.RISK_BAND_EXACT_RATE,
      }),
    ).toBe(true);
  });

  it("decays, so the corpus is not just three thresholds", () => {
    /**
     * Two cases carry the same signals at different ages and expect different
     * bands. Without them the suite would pass against a function that ignored
     * the clock entirely.
     */
    const recent = RISK_BAND_DATASET.find((c) => c.name.includes("departed champion"));
    const aged = RISK_BAND_DATASET.find((c) => c.name.includes("a year later"));

    /**
     * The same two signals, five days old and three hundred. One is on watch and
     * one has decayed to nothing — without this pair the suite would pass
     * against a function that ignored the clock entirely.
     */
    expect(recent?.input.expectedBand).toBe("watch");
    expect(aged?.input.expectedBand).toBe("healthy");
    expect(recent?.input.signals).toEqual(
      aged?.input.signals.map((signal, index) => ({
        impact: signal.impact,
        observedAt: recent?.input.signals[index]?.observedAt ?? signal.observedAt,
      })),
    );
  });
});

describe("the repair policy, gated on every refusal carrying a reason", () => {
  const allowed = { allowed: true as const, reason: null, source: "default" as const };
  const stopped = {
    allowed: false as const,
    reason: "kill-switch" as const,
    source: "org" as const,
  };

  const cases: readonly {
    name: string;
    input: { repairClass: string; autonomyOn: boolean; policies: { repairClass: string; enabled: boolean }[] };
    expected: boolean;
  }[] = [
    {
      name: "a conservative class runs on the platform default",
      input: { repairClass: "phone.non-ascii-characters", autonomyOn: true, policies: [] },
      expected: true,
    },
    {
      name: "a class that can change what a value denotes needs a grant",
      input: { repairClass: "email.whitespace", autonomyOn: true, policies: [] },
      expected: false,
    },
    {
      name: "a tenant grant turns that class on",
      input: {
        repairClass: "email.whitespace",
        autonomyOn: true,
        policies: [{ repairClass: "email.whitespace", enabled: true }],
      },
      expected: true,
    },
    {
      name: "a tenant refusal overrules the conservative default",
      input: {
        repairClass: "phone.non-ascii-characters",
        autonomyOn: true,
        policies: [{ repairClass: "phone.non-ascii-characters", enabled: false }],
      },
      expected: false,
    },
    {
      name: "the kill switch stops even a granted class",
      input: {
        repairClass: "email.whitespace",
        autonomyOn: false,
        policies: [{ repairClass: "email.whitespace", enabled: true }],
      },
      expected: false,
    },
    {
      name: "a class the system does not repair is never guessed at",
      input: { repairClass: "address.reformat", autonomyOn: true, policies: [] },
      expected: false,
    },
  ];

  it("decides the same way every time, and explains every refusal", async () => {
    const report = await runEval<(typeof cases)[number]["input"], RepairPermission>(
      cases.map((entry) => ({ name: entry.name, input: entry.input })),
      async (input) =>
        mayRepair(input.repairClass, {
          autonomySwitch: input.autonomyOn ? allowed : stopped,
          policies: input.policies,
        }),
      [
        {
          name: "REPAIR_DECISION_CORRECT_RATE",
          check: (permission, input) =>
            permission.allowed ===
            (cases.find((entry) => entry.input === input)?.expected ?? false),
        },
        {
          /**
           * Every branch returns a sentence. A refusal that is only a `false`
           * becomes a silence in the ledger, and "the system quietly did
           * nothing" is precisely the failure this loop must not have.
           */
          name: "REPAIR_REFUSAL_EXPLAINED_RATE",
          check: (permission) =>
            permission.allowed || permission.explanation.trim().length > 0,
        },
      ],
    );

    expect(report.total).toBe(cases.length);
    expect(
      meetsGate(report, {
        REPAIR_DECISION_CORRECT_RATE: EVAL_ACCEPTANCE.REPAIR_DECISION_CORRECT_RATE,
        REPAIR_REFUSAL_EXPLAINED_RATE: EVAL_ACCEPTANCE.REPAIR_REFUSAL_EXPLAINED_RATE,
      }),
    ).toBe(true);
    /** Both answers are represented, so 1.0 is not a function that always says no. */
    expect(cases.filter((c) => c.expected).length).toBeGreaterThanOrEqual(2);
    expect(cases.filter((c) => !c.expected).length).toBeGreaterThanOrEqual(2);
  });
});
