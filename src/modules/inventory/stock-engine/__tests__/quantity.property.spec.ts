import fc from "fast-check";
import { BadRequestException } from "@nestjs/common";
import {
  AVAILABLE_QTY_TERMS,
  addDec,
  availableQty,
  cmpDec,
  divDec,
  isNegative,
  isPositive,
  mulDec,
  netAvailableQty,
  subDec,
} from "../decimal";
import { toBaseQuantity } from "../uom-conversion.service";
import {
  Coverage,
  FACTOR_UNIT,
  QTY_UNIT,
  decimalString,
  factorUlps,
  fromUlps,
  isPromisable,
  levelInput,
  levelUlps,
  nonNegativeQtyUlps,
  qtyUlps,
  roundHalfUpAwayFromZero,
  signOf,
  type LevelUlps,
} from "./quantity-arbitraries";

/**
 * T16 — inventory's property gate. PRD §12.9 asked for one and there was none.
 *
 * Read `quantity-arbitraries.ts` first: it explains the model and why stating
 * the laws against exact `bigint` arithmetic is not the same as re-running the
 * implementation.
 *
 * ## What this is for
 *
 * The example tests beside this file check the cases somebody thought of.
 * Quantity arithmetic's defects are not in that set — they are at the rounding
 * boundary, at the sign flip, at the point where a term is added to one copy of
 * a formula and not another. This suite states the laws and lets the generator
 * hunt for the counterexample.
 *
 * Four laws carry most of the weight and none of them needs a model:
 *
 *  - `AVAILABLE_QTY_TERMS` is the complete list of what `availableQty`
 *    subtracts. Add a fifth bucket to the constant and forget the function —
 *    which is exactly how `outgoing_qty` came to be promised twice — and this
 *    fails on the first generated row.
 *  - Both availability gates dominate every quantity. No arrangement of the
 *    five numbers can make a non-sellable location or a consigned row sellable.
 *  - Availability is monotone: one more unit blocked is exactly one less unit
 *    available, never 0.9999 of one.
 *  - `toBaseQuantity` is exact. Three cases of twelve is `36.0000`, not
 *    `35.999999999999996`.
 *
 * ## What it does not claim
 *
 * Nothing here touches the database, the stock engine's transaction boundary,
 * or the SQL half of the availability formula — the SQL half is
 * `available-formula-parity.db.spec.ts`, which runs the same generated rows
 * through PostgreSQL. Passing does not mean quantities are right end to end; it
 * means these seven functions obey the laws they are documented to obey.
 *
 * Seeds are not pinned. A property that only holds for one seed is not a
 * property, and fast-check prints the seed and the shrunk counterexample on
 * failure, which is the whole reason to use a runner rather than a loop.
 */

/** Enough to walk the boundaries; small enough that the suite stays under a second. */
const RUNS = 600;
const coverage = new Coverage();

/**
 * The ulp field behind each name in `AVAILABLE_QTY_TERMS`.
 *
 * Deliberately keyed by the constant rather than duplicated as a list: the
 * first assertion below is that these two key sets are equal, so a term added
 * to the formula and not to this map fails here rather than silently dropping
 * out of the expected value.
 */
const TERM_FIELD: Record<(typeof AVAILABLE_QTY_TERMS)[number], keyof LevelUlps> = {
  committed: "committed",
  blocked_qty: "blocked",
  quality_hold_qty: "qualityHold",
  outgoing_qty: "outgoing",
};

function expectedAvailableUlps(level: LevelUlps): bigint {
  let remaining = level.onHand;
  for (const term of AVAILABLE_QTY_TERMS) {
    const value = level[TERM_FIELD[term]];
    if (typeof value !== "bigint") throw new Error(`term ${term} is not a quantity`);
    remaining -= value;
  }
  return remaining;
}

describe("T16 property — the model is pinned before anything is stated against it", () => {
  it("fromUlps writes the canonical scale-4 text", () => {
    expect(fromUlps(0n)).toBe("0.0000");
    expect(fromUlps(1n)).toBe("0.0001");
    expect(fromUlps(-1n)).toBe("-0.0001");
    expect(fromUlps(10_000n)).toBe("1.0000");
    expect(fromUlps(-123_456n)).toBe("-12.3456");
    expect(fromUlps(1_500_000n, FACTOR_UNIT)).toBe("1.500000");
  });

  it("roundHalfUpAwayFromZero sends a tie away from zero in both directions", () => {
    expect(roundHalfUpAwayFromZero(5n, 10n)).toBe(1n);
    expect(roundHalfUpAwayFromZero(-5n, 10n)).toBe(-1n);
    expect(roundHalfUpAwayFromZero(4n, 10n)).toBe(0n);
    expect(roundHalfUpAwayFromZero(-4n, 10n)).toBe(0n);
    expect(roundHalfUpAwayFromZero(15n, 10n)).toBe(2n);
    expect(roundHalfUpAwayFromZero(5n, -10n)).toBe(-1n);
  });

  it("signOf reports the three cases cmpDec promises", () => {
    expect([signOf(-7n), signOf(0n), signOf(7n)]).toEqual([-1, 0, 1]);
  });
});

describe("T16 property — decimal.ts is exact integer arithmetic wearing a string", () => {
  it("addDec is the sum of the two ulp counts", () => {
    fc.assert(
      fc.property(qtyUlps, qtyUlps, (a, b) => {
        coverage.observe("add", true);
        coverage.observe("add-negative-operand", a < 0n || b < 0n);
        coverage.observe("add-fractional", a % QTY_UNIT !== 0n || b % QTY_UNIT !== 0n);
        expect(addDec(fromUlps(a), fromUlps(b))).toBe(fromUlps(a + b));
      }),
      { numRuns: RUNS },
    );
  });

  it("addDec commutes and associates, so the order money is summed cannot change the total", () => {
    fc.assert(
      fc.property(qtyUlps, qtyUlps, qtyUlps, (a, b, c) => {
        const x = fromUlps(a);
        const y = fromUlps(b);
        const z = fromUlps(c);
        expect(addDec(x, y)).toBe(addDec(y, x));
        expect(addDec(addDec(x, y), z)).toBe(addDec(x, addDec(y, z)));
      }),
      { numRuns: RUNS },
    );
  });

  it("subDec is the additive inverse of addDec at every magnitude", () => {
    fc.assert(
      fc.property(qtyUlps, qtyUlps, (a, b) => {
        const x = fromUlps(a);
        const y = fromUlps(b);
        expect(subDec(x, y)).toBe(fromUlps(a - b));
        expect(subDec(addDec(x, y), y)).toBe(x);
        expect(addDec(subDec(x, y), y)).toBe(x);
      }),
      { numRuns: RUNS },
    );
  });

  it("mulDec rounds half away from zero, once, at the end", () => {
    fc.assert(
      fc.property(qtyUlps, qtyUlps, (a, b) => {
        const exact = a * b;
        coverage.observe("mul-rounds", exact % QTY_UNIT !== 0n);
        expect(mulDec(fromUlps(a), fromUlps(b))).toBe(
          fromUlps(roundHalfUpAwayFromZero(exact, QTY_UNIT)),
        );
        expect(mulDec(fromUlps(a), fromUlps(b))).toBe(mulDec(fromUlps(b), fromUlps(a)));
        expect(mulDec(fromUlps(a), "1.0000")).toBe(fromUlps(a));
        expect(mulDec(fromUlps(a), "0.0000")).toBe("0.0000");
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * `mulDec` rounds, so it cannot distribute exactly — and the interesting
   * question is by how much. Each of the three roundings moves its operand by
   * at most half an ulp, so the two sides differ by less than 1.5 ulp; both are
   * whole ulps, so they differ by at most one. A regression to floating point,
   * or to rounding twice, breaks this bound long before it breaks a spot check.
   */
  it("mulDec distributes over addDec to within a single ulp, never further", () => {
    fc.assert(
      fc.property(qtyUlps, qtyUlps, qtyUlps, (a, b, c) => {
        const x = fromUlps(a);
        const left = mulDec(x, addDec(fromUlps(b), fromUlps(c)));
        const right = addDec(mulDec(x, fromUlps(b)), mulDec(x, fromUlps(c)));
        const drift = subDec(left, right);
        coverage.observe("mul-distributes-inexactly", drift !== "0.0000");
        expect(cmpDec(drift, "0.0001")).toBeLessThanOrEqual(0);
        expect(cmpDec(drift, "-0.0001")).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: RUNS },
    );
  });

  it("divDec inverts mulDec at scale, and answers zero for a zero divisor rather than throwing", () => {
    fc.assert(
      fc.property(qtyUlps, qtyUlps, (a, b) => {
        const x = fromUlps(a);
        const y = fromUlps(b);
        if (b === 0n) {
          coverage.observe("div-by-zero");
          expect(divDec(x, y)).toBe("0.0000");
          return;
        }
        expect(divDec(x, y)).toBe(fromUlps(roundHalfUpAwayFromZero(a * QTY_UNIT, b)));
        expect(divDec(x, "1.0000")).toBe(x);
        expect(divDec(y, y)).toBe("1.0000");
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * The exact tie is the one case a uniform generator does not reach, and the
   * bite proof caught it: flipping `r * 2n >= b` to `r * 2n > b` in
   * `divRoundHalfUp` — half away from zero becoming half toward zero — left
   * this suite **green** (`EXIT=0`), because a product landing exactly on
   * `…5000` happens about once in ten thousand draws.
   *
   * So the ties are constructed rather than hoped for. `x ≡ 1000 (mod 2000)`
   * times `0.0005` is exactly `k.5` ulps; an odd number of ulps divided by
   * `2.0000` is exactly `m.5`; an odd number of ulps at a factor of `0.5` is
   * exactly `n.5` base units. Each is generated at both signs, because "half
   * up" and "half away from zero" agree on positives and differ on negatives.
   */
  it("an exact half rounds away from zero, at both signs, in all three operators", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.boolean(),
        (k, negate) => {
          const sign = negate ? -1n : 1n;

          const mulOperand = sign * (2_000n * k + 1_000n);
          coverage.observe("mul-tie");
          expect(mulDec(fromUlps(mulOperand), "0.0005")).toBe(
            fromUlps(sign * (k + 1n)),
          );

          const divOperand = sign * (2n * k + 1n);
          coverage.observe("div-tie");
          expect(divDec(fromUlps(divOperand), "2.0000")).toBe(
            fromUlps(sign * (k + 1n)),
          );

          coverage.observe("uom-tie");
          expect(toBaseQuantity(fromUlps(divOperand), "0.500000")).toBe(
            fromUlps(sign * (k + 1n)),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("cmpDec is a total order that agrees with subtraction", () => {
    fc.assert(
      fc.property(qtyUlps, qtyUlps, qtyUlps, (a, b, c) => {
        const x = fromUlps(a);
        const y = fromUlps(b);
        const z = fromUlps(c);
        expect(cmpDec(x, y)).toBe(signOf(a - b));
        // Summed rather than negated: `-0` and `0` are different values to
        // `Object.is`, which is what `toBe` uses, and equal comparands make the
        // negation produce one. The runner found that on its fiftieth case.
        expect(cmpDec(x, y) + cmpDec(y, x)).toBe(0);
        if (cmpDec(x, y) <= 0 && cmpDec(y, z) <= 0) expect(cmpDec(x, z)).toBeLessThanOrEqual(0);
      }),
      { numRuns: RUNS },
    );
  });

  it("isNegative and isPositive partition the line with zero in neither half", () => {
    fc.assert(
      fc.property(qtyUlps, (a) => {
        const x = fromUlps(a);
        coverage.observe("sign-negative", a < 0n);
        coverage.observe("sign-zero", a === 0n);
        coverage.observe("sign-positive", a > 0n);
        expect(isNegative(x)).toBe(a < 0n);
        expect(isPositive(x)).toBe(a > 0n);
        expect(isNegative(x) && isPositive(x)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it("every operator emits canonical scale-4 text, so a stored quantity is never ragged", () => {
    const canonical = /^-?\d+\.\d{4}$/;
    fc.assert(
      fc.property(decimalString, decimalString, (x, y) => {
        for (const out of [addDec(x, y), subDec(x, y), mulDec(x, y), divDec(x, y)])
          expect(out).toMatch(canonical);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("T16 property — availableQty subtracts exactly the declared terms and nothing else", () => {
  it("AVAILABLE_QTY_TERMS and this suite's term map name the same four buckets", () => {
    expect([...AVAILABLE_QTY_TERMS].sort()).toEqual(Object.keys(TERM_FIELD).sort());
  });

  it("availability is on_hand less every term in AVAILABLE_QTY_TERMS, for any promisable row", () => {
    fc.assert(
      fc.property(levelUlps, (level) => {
        coverage.observe("level", true);
        coverage.observe("level-promisable", isPromisable(level));
        coverage.observe("level-blocked-by-location", level.isSellable === false);
        coverage.observe(
          "level-blocked-by-ownership",
          level.isSellable !== false &&
            level.ownership !== undefined &&
            level.ownership !== null &&
            level.ownership !== "OWNED",
        );
        const answer = availableQty(levelInput(level));
        if (!isPromisable(level)) {
          expect(answer).toBe("0.0000");
          return;
        }
        expect(answer).toBe(fromUlps(expectedAvailableUlps(level)));
      }),
      { numRuns: RUNS },
    );
  });

  it("neither gate can be out-argued by the numbers", () => {
    fc.assert(
      fc.property(levelUlps, (level) => {
        expect(availableQty({ ...levelInput(level), is_sellable: false })).toBe("0.0000");
        for (const ownership of ["VENDOR", "CUSTOMER"] as const)
          expect(availableQty({ ...levelInput(level), is_sellable: true, ownership })).toBe("0.0000");
      }),
      { numRuns: RUNS },
    );
  });

  it("the permissive values of both gates are indistinguishable from each other", () => {
    fc.assert(
      fc.property(levelUlps, (level) => {
        const base = { ...levelInput(level), is_sellable: true, ownership: "OWNED" as const };
        const answers = [
          availableQty(base),
          availableQty({ ...base, is_sellable: null }),
          availableQty({ ...base, is_sellable: undefined }),
          availableQty({ ...base, ownership: null }),
          availableQty({ ...base, ownership: undefined }),
        ];
        expect(new Set(answers).size).toBe(1);
      }),
      { numRuns: RUNS },
    );
  });

  it("a null bucket is a zero bucket, not a dropped term", () => {
    fc.assert(
      fc.property(levelUlps, (level) => {
        const zeroed: LevelUlps = { ...level, blocked: 0n, qualityHold: 0n, outgoing: 0n };
        const withNulls = {
          ...levelInput(zeroed),
          blocked_qty: null,
          quality_hold_qty: null,
          outgoing_qty: null,
        };
        expect(availableQty(withNulls)).toBe(availableQty(levelInput(zeroed)));
      }),
      { numRuns: RUNS },
    );
  });

  it("one more unit held is exactly one less unit available, and never more than on hand", () => {
    fc.assert(
      fc.property(
        levelUlps,
        fc.integer({ min: 0, max: AVAILABLE_QTY_TERMS.length - 1 }),
        nonNegativeQtyUlps,
        (raw, termIndex, delta) => {
          const level: LevelUlps = { ...raw, isSellable: true, ownership: "OWNED" };
          const term = AVAILABLE_QTY_TERMS[termIndex];
          if (term === undefined) throw new Error("term index out of range");
          const field = TERM_FIELD[term];
          const current = level[field];
          if (typeof current !== "bigint") throw new Error(`term ${term} is not a quantity`);

          const before = availableQty(levelInput(level));
          const after = availableQty(levelInput({ ...level, [field]: current + delta }));
          coverage.observe("monotone-delta-positive", delta > 0n);
          expect(subDec(before, after)).toBe(fromUlps(delta));
          expect(cmpDec(before, fromUlps(level.onHand))).toBeLessThanOrEqual(0);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("T16 property — netAvailableQty never promises a negative and never invents stock", () => {
  it("clamps at zero, stays at or below the row figure, and is exact above the clamp", () => {
    fc.assert(
      fc.property(qtyUlps, nonNegativeQtyUlps, (availableUlps, reservedUlps) => {
        const available = fromUlps(availableUlps);
        const reserved = fromUlps(reservedUlps);
        const net = netAvailableQty(available, reserved);
        coverage.observe("net-clamped", availableUlps - reservedUlps < 0n);
        expect(isNegative(net)).toBe(false);
        if (availableUlps >= 0n) expect(cmpDec(net, available)).toBeLessThanOrEqual(0);
        if (availableUlps - reservedUlps >= 0n)
          expect(net).toBe(fromUlps(availableUlps - reservedUlps));
        else expect(net).toBe("0.0000");
      }),
      { numRuns: RUNS },
    );
  });

  it("no pool is the same answer as an empty pool", () => {
    fc.assert(
      fc.property(nonNegativeQtyUlps, (a) => {
        const available = fromUlps(a);
        expect(netAvailableQty(available, null)).toBe(available);
        expect(netAvailableQty(available, undefined)).toBe(available);
        expect(netAvailableQty(available, "0")).toBe(available);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("T16 property — toBaseQuantity converts units without floating point", () => {
  it("three cases of twelve is thirty-six, exactly", () => {
    expect(toBaseQuantity("3", "12")).toBe("36.0000");
    expect(toBaseQuantity("0.1", "3")).toBe("0.3000");
  });

  it("entered × factor is the exact product, rounded once", () => {
    fc.assert(
      fc.property(qtyUlps, factorUlps, (entered, factor) => {
        const product = entered * factor;
        coverage.observe("uom-rounds", product % FACTOR_UNIT !== 0n);
        expect(toBaseQuantity(fromUlps(entered), fromUlps(factor, FACTOR_UNIT))).toBe(
          fromUlps(roundHalfUpAwayFromZero(product, FACTOR_UNIT)),
        );
      }),
      { numRuns: RUNS },
    );
  });

  it("a factor of one is the identity, and the sign of what was typed survives", () => {
    fc.assert(
      fc.property(qtyUlps, factorUlps, (entered, factor) => {
        const converted = toBaseQuantity(fromUlps(entered), fromUlps(factor, FACTOR_UNIT));
        expect(toBaseQuantity(fromUlps(entered), "1.000000")).toBe(fromUlps(entered));
        if (isNegative(converted)) expect(entered < 0n).toBe(true);
        if (isPositive(converted)) expect(entered > 0n).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("more of the same unit is more of the base unit", () => {
    fc.assert(
      fc.property(nonNegativeQtyUlps, nonNegativeQtyUlps, factorUlps, (a, delta, factor) => {
        const f = fromUlps(factor, FACTOR_UNIT);
        const lower = toBaseQuantity(fromUlps(a), f);
        const higher = toBaseQuantity(fromUlps(a + delta), f);
        expect(cmpDec(lower, higher)).toBeLessThanOrEqual(0);
      }),
      { numRuns: RUNS },
    );
  });

  it("a factor of zero or less is refused rather than silently treated as one", () => {
    fc.assert(
      fc.property(qtyUlps, factorUlps, (entered, factor) => {
        for (const bad of ["0.000000", fromUlps(-factor, FACTOR_UNIT)])
          expect(() => toBaseQuantity(fromUlps(entered), bad)).toThrow(BadRequestException);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * ANTI-VACUITY. Every law above is satisfied by a generator that only ever
 * emits `0.0000`, and by `numRuns: 0`. These floors are what makes a green here
 * mean the properties were exercised rather than merely declared.
 */
describe("T16 property — the generators are proved to have produced the cases that matter", () => {
  it("exercised both signs, the fractional boundary, both availability gates and the clamp", () => {
    const floors: ReadonlyArray<readonly [string, number]> = [
      ["add", RUNS],
      ["add-negative-operand", 100],
      ["add-fractional", 100],
      ["mul-rounds", 100],
      ["mul-distributes-inexactly", 20],
      // The three floors the bite proof forced: a uniform generator reaches an
      // exact tie roughly once in ten thousand draws, so half-down passed.
      ["mul-tie", RUNS],
      ["div-tie", RUNS],
      ["uom-tie", RUNS],
      ["sign-negative", 100],
      ["sign-positive", 100],
      ["level", RUNS],
      ["level-promisable", 100],
      ["level-blocked-by-location", 50],
      ["level-blocked-by-ownership", 50],
      ["monotone-delta-positive", 100],
      ["net-clamped", 50],
      ["uom-rounds", 100],
    ];
    const short = floors.filter(([label, floor]) => coverage.count(label) < floor);
    expect(
      short.map(([label, floor]) => `${label}: ${coverage.count(label)} < ${floor}`).join("; ") +
        (short.length ? ` | observed: ${coverage.summary()}` : ""),
    ).toBe("");
  });
});
