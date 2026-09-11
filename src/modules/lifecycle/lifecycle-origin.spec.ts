import { lifecycleFromClosedWon, type ClosedWonDeal } from "./lifecycle-origin";
import { DEFAULT_TERM_MONTHS } from "./lifecycle-terms";

const NOW = new Date("2026-08-27T12:00:00.000Z");

const deal = (over: Partial<ClosedWonDeal> = {}): ClosedWonDeal => ({
  organizationId: "org-1",
  dealId: 42,
  partyId: "party-1",
  valueMinor: 1_200_00,
  actualCloseDate: "2026-08-27",
  customData: null,
  now: NOW,
  ...over,
});

/**
 * Two failures are invisible at runtime and neither shows up in a test that
 * mocks the database and asserts an insert happened: opening a term for a deal
 * that names no customer, and refusing to open one for a deal that does. The
 * first puts untraceable money in the renewal forecast; the second loses real
 * money out of it. Every case here is one or the other.
 */
describe("lifecycleFromClosedWon", () => {
  it("opens an annual term from the deal's close date", () => {
    const origin = lifecycleFromClosedWon(deal());

    expect(origin).toEqual({
      ok: true,
      values: {
        organizationId: "org-1",
        partyId: "party-1",
        sourceDealId: 42,
        startedOn: "2026-08-27",
        termMonths: DEFAULT_TERM_MONTHS,
        renewalOn: "2027-08-27",
        contractValueMinor: 120000,
      },
    });
  });

  /**
   * The refusal that matters. Deals are routinely won against a lead nobody
   * converted; there is no customer to hold a recurring relationship with, and
   * inventing a row would put revenue in the book that no account can be
   * traced to.
   */
  it("refuses when no party resolved, and says so as a value", () => {
    expect(lifecycleFromClosedWon(deal({ partyId: null }))).toEqual({
      ok: false,
      reason: "no-party",
    });
  });

  it("honours a term the tenant stated on the deal", () => {
    const origin = lifecycleFromClosedWon(deal({ customData: { termMonths: 36 } }));

    expect(origin.ok && origin.values.termMonths).toBe(36);
    expect(origin.ok && origin.values.renewalOn).toBe("2029-08-27");
  });

  /**
   * A typo in an untyped JSON blob must not be able to cost a customer their
   * place in the renewal book. It falls back rather than refusing.
   */
  it("still opens a term when the stated one is nonsense", () => {
    const origin = lifecycleFromClosedWon(deal({ customData: { termMonths: "soon" } }));

    expect(origin.ok && origin.values.termMonths).toBe(DEFAULT_TERM_MONTHS);
    expect(origin.ok && origin.values.renewalOn).toBe("2027-08-27");
  });

  /**
   * A deal imported straight into a won stage has never had a close date
   * written. Dating its term from nothing would produce a null renewal date on a
   * NOT NULL column and abort the transaction that closed the sale.
   */
  it.each([
    [null, "never set"],
    ["", "empty"],
    ["27 August 2026", "not a stored date"],
  ])("falls back to today when the close date is %p (%s)", (actualCloseDate, _why) => {
    const origin = lifecycleFromClosedWon(deal({ actualCloseDate }));

    expect(origin.ok && origin.values.startedOn).toBe("2026-08-27");
    expect(origin.ok && origin.values.renewalOn).toBe("2027-08-27");
  });

  /**
   * The month-end clamp, reached through the real entry point rather than only
   * through the arithmetic — 31 January plus twelve months is still 31 January,
   * but 31 January plus one month is not 3 March.
   */
  it("clamps a month-end start to the end of a shorter month", () => {
    const origin = lifecycleFromClosedWon(
      deal({ actualCloseDate: "2026-01-31", customData: { termMonths: 1 } }),
    );

    expect(origin.ok && origin.values.renewalOn).toBe("2026-02-28");
  });

  /**
   * A pilot, a goodwill renewal, a correction still pending — all worth
   * tracking to a renewal date. Zero is a value, not a missing customer.
   */
  it("opens a term for a zero-value win", () => {
    const origin = lifecycleFromClosedWon(deal({ valueMinor: 0 }));
    expect(origin.ok && origin.values.contractValueMinor).toBe(0);
  });

  /**
   * Negative is a data error rather than a contract. Floored rather than
   * refused, so the customer stays in the book with a number somebody can see is
   * wrong instead of vanishing from it.
   */
  it("floors a negative value rather than dropping the customer", () => {
    const origin = lifecycleFromClosedWon(deal({ valueMinor: -50_00 }));
    expect(origin.ok && origin.values.contractValueMinor).toBe(0);
  });

  /** Money is integer minor units. A fractional cent must not reach the column. */
  it("truncates a fractional minor-unit value to an integer", () => {
    const origin = lifecycleFromClosedWon(deal({ valueMinor: 120000.4 }));
    expect(origin.ok && origin.values.contractValueMinor).toBe(120000);
  });

  it("survives a non-finite value rather than writing NaN", () => {
    const origin = lifecycleFromClosedWon(deal({ valueMinor: Number.NaN }));
    expect(origin.ok && origin.values.contractValueMinor).toBe(0);
  });
});
