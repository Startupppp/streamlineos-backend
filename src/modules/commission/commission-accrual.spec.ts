import type { CommissionRuleSet } from "../../db/schema/crm/commission";
import { evaluateCommission } from "./commission-rules";
import {
  apportion,
  assertPartsSumTo,
  decomposeEvaluation,
  sliceWeight,
  summariseByRule,
} from "./commission-accrual";

/**
 * The ticket's acceptance test: the parts always sum to the whole.
 *
 * "Exactly" is literal here. These are integer minor units, so a residue of one
 * is a residue, and the failure it produces is specific and expensive: a rep
 * opens their accrual, adds up the deals listed under it, and gets a different
 * number from the total printed above them. Nobody reports that as a rounding
 * artefact. They report it as the commission system being wrong, and the next
 * hour goes on proving it is not.
 *
 * The property is checked against randomly generated rule sets rather than a
 * handful of examples, because the shapes that break it are not the ones anybody
 * writes a fixture for: a cap that binds, two bands whose rounding residues
 * happen to fall the same way, a slice of a single minor unit. The generator is
 * seeded, so a failure here reproduces exactly rather than only on Tuesdays.
 *
 * Two of these tests exist specifically to stop this file becoming vacuous. A
 * generator that quietly stopped producing capped evaluations, or stopped
 * producing ones where the naive per-slice rounding disagrees, would leave every
 * assertion below passing while testing nothing at all.
 */

/** Seeded PRNG. A failure here has to reproduce, or it cannot be fixed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generated {
  rules: CommissionRuleSet;
  basisMinor: number;
  priorBasisMinor: number;
}

/**
 * A rule set the evaluator will accept, spanning the shapes that matter:
 * quota-relative and absolute bands, one to four tiers, accelerators, and a cap
 * tight enough to actually bind roughly a fifth of the time.
 */
function generate(random: () => number): Generated {
  const int = (n: number): number => Math.floor(random() * n);
  const withQuota = random() < 0.5;
  const tierCount = 1 + int(4);

  const froms = new Set<number>([0]);
  while (froms.size < tierCount) froms.add(1 + int(withQuota ? 40_000 : 4_000_000));

  const tiers = [...froms]
    .sort((a, b) => a - b)
    .map((from) => ({ from, rateBps: int(10_001) }));

  const accelerators =
    withQuota && random() < 0.4
      ? [{ aboveBps: 1 + int(20_000), multiplierBps: 10_000 + int(20_000) }]
      : [];

  return {
    rules: {
      basis: "deal_value",
      period: "MONTH",
      quotaMinor: withQuota ? 1 + int(5_000_000) : null,
      tiers,
      accelerators,
      capMinor: random() < 0.25 ? 1 + int(400_000) : null,
    },
    basisMinor: int(8_000_000),
    priorBasisMinor: int(3_000_000),
  };
}

const sum = (parts: readonly { amountMinor: number }[]): number =>
  parts.reduce((running, part) => running + part.amountMinor, 0);

describe("a decomposition reconstructs its total exactly", () => {
  /**
   * The property, over five thousand generated plans.
   *
   * If this fails, an accrued figure somewhere does not equal the deals listed
   * under it.
   */
  it("holds for every generated rule set", () => {
    const random = mulberry32(0x5eed_05);

    for (let trial = 0; trial < 5_000; trial += 1) {
      const { rules, basisMinor, priorBasisMinor } = generate(random);
      const evaluation = evaluateCommission(rules, { basisMinor, priorBasisMinor });
      const parts = decomposeEvaluation(evaluation);

      if (sum(parts) !== evaluation.amountMinor)
        throw new Error(
          `trial ${trial}: parts sum to ${sum(parts)}, total is ${evaluation.amountMinor} — ${JSON.stringify(
            { rules, basisMinor, priorBasisMinor },
          )}`,
        );
    }
  });

  /**
   * Not a duplicate of the test above: that one proves the sum, this one proves
   * the generator is producing the hard cases. A generator that drifted into
   * only emitting single-band, uncapped plans would leave every assertion in
   * this file passing while exercising nothing.
   */
  it("generates the cases that would break a naive decomposition", () => {
    const random = mulberry32(0x5eed_05);
    let capped = 0;
    let naiveWouldDisagree = 0;
    let multiBand = 0;

    for (let trial = 0; trial < 5_000; trial += 1) {
      const { rules, basisMinor, priorBasisMinor } = generate(random);
      const evaluation = evaluateCommission(rules, { basisMinor, priorBasisMinor });
      if (evaluation.capped) capped += 1;
      if (evaluation.slices.length > 1) multiBand += 1;
      // What shipping `CommissionSlice.amountMinor` as the decomposition would
      // have produced — the bug this module exists to prevent.
      if (sum(evaluation.slices) !== evaluation.amountMinor) naiveWouldDisagree += 1;
    }

    expect(capped).toBeGreaterThan(100);
    expect(multiBand).toBeGreaterThan(500);
    expect(naiveWouldDisagree).toBeGreaterThan(500);
  });

  /**
   * The same input decomposed twice gives byte-identical parts.
   *
   * Largest-remainder apportionment has to break ties by something, and if that
   * something were the sort's stability rather than the index, a rebuild would
   * silently move a minor unit between two deals — and the ledger would
   * disagree with a payslip somebody had already read.
   */
  it("is deterministic, so a rebuild reproduces the same split", () => {
    const random = mulberry32(0xd06);

    for (let trial = 0; trial < 500; trial += 1) {
      const { rules, basisMinor, priorBasisMinor } = generate(random);
      const evaluation = evaluateCommission(rules, { basisMinor, priorBasisMinor });
      expect(decomposeEvaluation(evaluation)).toEqual(decomposeEvaluation(evaluation));
    }
  });

  /**
   * Rolling parts up to their rules cannot lose or invent a minor unit.
   *
   * The API returns the same accrual grouped two ways — by deal and by rule —
   * beside one headline figure. If a roll-up did not preserve the total, one of
   * the two breakdowns would fail to add up to the number above it.
   */
  it("survives being rolled up to the rule that produced each part", () => {
    const random = mulberry32(0xc0ffee);

    for (let trial = 0; trial < 1_000; trial += 1) {
      const { rules, basisMinor, priorBasisMinor } = generate(random);
      const evaluation = evaluateCommission(rules, { basisMinor, priorBasisMinor });
      const parts = decomposeEvaluation(evaluation);
      expect(sum(summariseByRule(parts))).toBe(evaluation.amountMinor);
    }
  });

  /**
   * A cap is attributed, not left dangling.
   *
   * The pre-cap bands are worth far more than the settled total, and the parts
   * still reconstruct what is actually owed. Without this, "why is my top band
   * worth less than the rate says" has no answer on the row.
   */
  it("apportions a binding cap across the bands that earned it", () => {
    const rules: CommissionRuleSet = {
      basis: "deal_value",
      period: "MONTH",
      quotaMinor: null,
      tiers: [
        { from: 0, rateBps: 1_000 },
        { from: 1_000_000, rateBps: 2_000 },
      ],
      accelerators: [],
      capMinor: 50_000,
    };

    const evaluation = evaluateCommission(rules, {
      basisMinor: 5_000_000,
      priorBasisMinor: 0,
    });

    expect(evaluation.capped).toBe(true);
    expect(evaluation.amountMinor).toBe(50_000);
    // The naive decomposition would have claimed 900,000 — eighteen times the
    // money actually owed.
    expect(sum(evaluation.slices)).toBe(900_000);

    const parts = decomposeEvaluation(evaluation);
    expect(sum(parts)).toBe(50_000);
    expect(parts).toHaveLength(2);
    // Proportional to what each band earned before the cap bit, not flat.
    expect(parts[1]!.amountMinor).toBeGreaterThan(parts[0]!.amountMinor);
  });

  /**
   * The exact case `commission-rules.spec.ts` documents: two slices of half a
   * minor unit each, displaying as 1 and 1 against a total of 1.
   *
   * That spec asserts the display roundings stay as they are. This asserts the
   * decomposition does not inherit them.
   */
  it("resolves the half-unit slice pair the evaluator rounds to [1, 1]", () => {
    const rules: CommissionRuleSet = {
      basis: "deal_value",
      period: "MONTH",
      quotaMinor: null,
      tiers: [
        { from: 0, rateBps: 5_000 },
        { from: 1, rateBps: 5_000 },
      ],
      accelerators: [],
      capMinor: null,
    };

    const evaluation = evaluateCommission(rules, { basisMinor: 2, priorBasisMinor: 0 });
    expect(evaluation.amountMinor).toBe(1);
    expect(evaluation.slices.map((slice) => slice.amountMinor)).toEqual([1, 1]);

    const parts = decomposeEvaluation(evaluation);
    expect(sum(parts)).toBe(1);
    // The single unit goes to the first band on a tie, by index. Deterministic.
    expect(parts.map((part) => part.amountMinor)).toEqual([1, 0]);
  });

  /** An earning that paid nothing decomposes to parts that pay nothing. */
  it("decomposes a zero payout without inventing a part", () => {
    const rules: CommissionRuleSet = {
      basis: "deal_value",
      period: "MONTH",
      quotaMinor: null,
      tiers: [{ from: 0, rateBps: 0 }],
      accelerators: [],
      capMinor: null,
    };

    const evaluation = evaluateCommission(rules, {
      basisMinor: 1_000_000,
      priorBasisMinor: 0,
    });
    expect(evaluation.amountMinor).toBe(0);
    expect(sum(decomposeEvaluation(evaluation))).toBe(0);
  });
});

describe("apportion", () => {
  it("splits a total across weights with no residue", () => {
    expect(apportion(10, [1n, 1n, 1n])).toEqual([4, 3, 3]);
    expect(apportion(10, [1n, 1n, 1n]).reduce((a, b) => a + b, 0)).toBe(10);
  });

  /**
   * A clawback has to be the exact reverse of the earning it reverses. If the
   * two fail to cancel, a ledger will not return to zero after a reversal, and
   * that is a day of somebody's life.
   */
  it("mirrors exactly under negation", () => {
    const random = mulberry32(0xbeef);

    for (let trial = 0; trial < 500; trial += 1) {
      const weights = Array.from(
        { length: 1 + Math.floor(random() * 5) },
        () => BigInt(Math.floor(random() * 1_000_000)),
      );
      const total = Math.floor(random() * 500_000);
      expect(apportion(-total, weights)).toEqual(
        apportion(total, weights).map((share) => -share),
      );
    }
  });

  /**
   * Weightless bands with money to place. There is no principled split, so it
   * is concentrated on one part rather than smeared by a rule nobody could
   * explain to the person it shorted — and it is still exact.
   */
  it("places a total that no weight accounts for, rather than dropping it", () => {
    expect(apportion(7, [0n, 0n, 0n])).toEqual([7, 0, 0]);
  });

  /**
   * Losing money between the evaluator and the ledger is the one failure nobody
   * would notice, so it is the one that must be loud.
   */
  it("refuses to discard a total it has nowhere to put", () => {
    expect(() => apportion(5, [])).toThrow(/nowhere|no parts/i);
    expect(apportion(0, [])).toEqual([]);
  });

  it("rejects a negative weight rather than producing a nonsense split", () => {
    expect(() => apportion(10, [1n, -1n])).toThrow(/negative/i);
  });

  /**
   * A basis past `Number.MAX_SAFE_INTEGER` once multiplied by a rate and a
   * multiplier. In `number` arithmetic the weights would be wrong by thousands
   * and the split would still look plausible.
   */
  it("stays exact on weights past the safe-integer range", () => {
    const weights = [10n ** 20n, 3n * 10n ** 20n];
    const shares = apportion(1_000_001, weights);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_001);
    expect(shares).toEqual([250_000, 750_001]);
  });

  it("weighs a slice by the magnitude of its basis, so a reversal still splits", () => {
    expect(sliceWeight({
      fromMinor: 0,
      toMinor: -100,
      basisMinor: -100,
      tierIndex: 0,
      tierFrom: 0,
      rateBps: 1_000,
      multiplierBps: 10_000,
      amountMinor: -10,
    })).toBe(100n * 1_000n * 10_000n);
  });
});

describe("assertPartsSumTo", () => {
  /**
   * The write-path guard. Parts and total reach the database as separate
   * columns of separate tables, so a decomposition that does not add up looks
   * entirely normal on the row until somebody totals a column.
   */
  it("throws when a part has been doctored", () => {
    expect(() => assertPartsSumTo(100, [{ amountMinor: 60 }, { amountMinor: 41 }])).toThrow(
      /does not reconstruct its total/,
    );
  });

  it("passes on an exact decomposition", () => {
    expect(() =>
      assertPartsSumTo(100, [{ amountMinor: 60 }, { amountMinor: 40 }]),
    ).not.toThrow();
  });
});
