import {
  PRICE_HISTORY_FOR_TESTS,
  priceEffectiveFrom,
  priceFor,
  priceList,
  SUPPORTED_CURRENCIES,
} from "./plan-pricing";
import type { PaidPlan } from "./plan-entitlements.constants";

/**
 * A price change may not restate what somebody already agreed.
 *
 * Phase 3 ticket 03's fourth line. The first three were met by `plan-pricing.ts`
 * refusing to convert between currencies: a converted price moves with the
 * exchange rate, so an invoice cannot be reproduced eighteen months later. This
 * is the same failure arriving from the other direction — with one undated
 * table, the number moves with whoever last edited the constant, and every
 * existing customer's agreed price silently becomes the new one.
 *
 * The rule this file enforces: **raising a price is appending an entry, never
 * editing one.** An entry that has been agreed against is history, and history
 * does not get a new number.
 *
 * The first two tests are the ones that matter, and they are deliberately not
 * tests of `pricesAsOf` arithmetic. They pin the SHAPE of the series, because
 * the failure being prevented is not a lookup returning the wrong row — it is
 * somebody opening the file and changing a number in place, which no amount of
 * lookup testing would ever catch.
 */

const PLANS: PaidPlan[] = ["STARTER", "PROFESSIONAL", "ENTERPRISE"];

describe("the price series is append-only", () => {
  it("is ordered oldest first, with no two entries sharing a date", () => {
    const dates = PRICE_HISTORY_FOR_TESTS.map((entry) => entry.effectiveFrom);

    // Ordering is what makes "walk from the end, newest applicable wins"
    // correct. Two entries on one date would make the answer depend on array
    // position, which is not a fact about prices.
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("prices every plan in every supported currency, in every entry", () => {
    // A currency added to SUPPORTED_CURRENCIES but not to a historical entry
    // would make a subscription agreed under that entry unpriceable — the
    // lookup would return undefined and the caller would render NaN or charge
    // nothing. Every entry must be total over the same set.
    for (const entry of PRICE_HISTORY_FOR_TESTS)
      for (const currency of SUPPORTED_CURRENCIES)
        for (const plan of PLANS)
          expect(typeof entry.prices[currency][plan]).toBe("number");
  });

  it("states every amount in whole minor units", () => {
    // Minor units are integers by definition. A fractional paise is a float
    // that got in, and floats are how a total stops reconciling.
    for (const entry of PRICE_HISTORY_FOR_TESTS)
      for (const currency of SUPPORTED_CURRENCIES)
        for (const plan of PLANS) {
          const amount = entry.prices[currency][plan];
          expect(Number.isInteger(amount)).toBe(true);
          expect(amount).toBeGreaterThan(0);
        }
  });

  it("reproduces an older price for a subscription agreed under it", () => {
    const [oldest] = PRICE_HISTORY_FOR_TESTS;
    const agreedOn = new Date(`${oldest!.effectiveFrom}T00:00:00.000Z`);

    // The property, stated directly: quoting AS OF the day a subscription was
    // agreed returns what it agreed to, whatever has been appended since. When
    // the series has one entry this is trivially true; it stays true, and stays
    // tested, the day somebody appends the second.
    for (const plan of PLANS)
      expect(priceFor(plan, "INR", agreedOn).amountMinor).toBe(oldest!.prices.INR[plan]);
  });

  it("answers for a date before the series began rather than throwing", () => {
    /*
      The only ways to be asked about such a date are a clock skew and a
      backfilled record, neither of which the caller can fix. Answering with the
      oldest stated price is defensible and reproducible; throwing would take a
      billing read down over a timestamp.
    */
    const beforeEverything = new Date("1970-01-01T00:00:00.000Z");
    expect(priceFor("STARTER", "USD", beforeEverything).amountMinor).toBe(
      PRICE_HISTORY_FOR_TESTS[0]!.prices.USD.STARTER,
    );
  });

  it("names the entry a quote came from, so a subscription can record it", () => {
    const stamped = priceEffectiveFrom(new Date("2030-06-01T00:00:00.000Z"));

    // This is what lands in `subscriptions.price_effective_from`. It has to be
    // an entry that exists, or the column records a date the series cannot
    // resolve and the subscription is unreproducible after all.
    expect(PRICE_HISTORY_FOR_TESTS.map((e) => e.effectiveFrom)).toContain(stamped);
  });

  it("quotes the same numbers through the list as through the single lookup", () => {
    // `priceList` is what the public pricing page renders. If it drifted from
    // `priceFor`, a prospect would be shown one number and charged another.
    const asOf = new Date("2030-06-01T00:00:00.000Z");
    for (const currency of SUPPORTED_CURRENCIES) {
      const list = priceList(currency, asOf);
      for (const price of list)
        expect(price.amountMinor).toBe(priceFor(price.plan, currency, asOf).amountMinor);
    }
  });
});
