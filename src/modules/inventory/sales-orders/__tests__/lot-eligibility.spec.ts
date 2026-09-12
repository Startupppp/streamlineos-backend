import {
  daysRemaining,
  isNearExpiry,
  nearExpiryHorizon,
  overridable,
  overriddenRule,
  verdictFor,
  type EligibilityPolicy,
  type LotFacts,
} from "../lot-eligibility";

/**
 * D2 — the four questions, and the proof they stay apart.
 *
 * INV-402 was one collapse of these (eligibility hidden inside the FEFO branch,
 * so every other strategy shipped expired stock). Each new axis is a fresh
 * chance to collapse them, so the tensions are asserted directly:
 *
 *   * FEFO wants the soonest-expiring lot first and near-expiry policy wants it
 *     last — both satisfied, because one tiers and the other orders within a tier;
 *   * the customer's shelf-life floor outranks `DEPRIORITIZE`, because "take it
 *     last" is still taking it and a contract says "do not take it at all";
 *   * the floor is not the near-expiry window under another name — a lot outside
 *     the window can still break the floor, which is the case that proves the
 *     second number earns its place.
 */

const TODAY = "2026-08-29";

function lots(entries: Array<[number, Partial<LotFacts>]>): ReadonlyMap<number, LotFacts> {
  return new Map(
    entries.map(([id, facts]) => [
      id,
      { expiryDate: null, status: "ACTIVE", ...facts } satisfies LotFacts,
    ]),
  );
}

const BLOCK_EXPIRED: EligibilityPolicy = {
  expiryPolicy: "BLOCK",
  nearExpiryPolicy: "ALLOW",
  nearExpiryWindowDays: 30,
  minShelfLifeDays: 0,
};

describe("D2 lot eligibility", () => {
  describe("the near-expiry horizon", () => {
    it("counts forward from today in whole days", () => {
      expect(nearExpiryHorizon(30, TODAY)).toBe("2026-09-28");
      expect(nearExpiryHorizon(90, TODAY)).toBe("2026-11-27");
      expect(nearExpiryHorizon(0, TODAY)).toBe(TODAY);
    });

    it("treats a lot with no expiry date as never near expiry", () => {
      expect(isNearExpiry({ expiryDate: null, status: "ACTIVE" }, 90, TODAY)).toBe(false);
    });

    it("does not call an already-expired lot near expiry — that is the other question", () => {
      expect(isNearExpiry({ expiryDate: "2026-08-01", status: "ACTIVE" }, 90, TODAY)).toBe(false);
      expect(isNearExpiry({ expiryDate: TODAY, status: "ACTIVE" }, 90, TODAY)).toBe(false);
    });

    it("includes the horizon day itself and excludes the one after", () => {
      expect(isNearExpiry({ expiryDate: "2026-09-28", status: "ACTIVE" }, 30, TODAY)).toBe(true);
      expect(isNearExpiry({ expiryDate: "2026-09-29", status: "ACTIVE" }, 30, TODAY)).toBe(false);
    });
  });

  describe("what may reach a customer at all", () => {
    it("refuses a recalled lot under every policy, including ALLOW", () => {
      const map = lots([[1, { status: "RECALLED", expiryDate: "2027-01-01" }]]);
      for (const nearExpiryPolicy of ["ALLOW", "DEPRIORITIZE", "BLOCK"] as const) {
        expect(
          verdictFor(1, map, { ...BLOCK_EXPIRED, nearExpiryPolicy }, TODAY),
        ).toEqual({ kind: "REFUSED", reason: "LOT_STATUS" });
      }
    });

    it("refuses a lot id that resolves to nothing rather than treating it as untracked", () => {
      // An untracked line has `lotId === null`. A lot id pointing at no row is a
      // dangling reference, and allocating against it promises stock whose
      // expiry nobody can check.
      expect(verdictFor(99, lots([]), BLOCK_EXPIRED, TODAY)).toEqual({
        kind: "REFUSED",
        reason: "LOT_STATUS",
      });
    });

    it("allows untracked stock, which has no lot to judge", () => {
      expect(verdictFor(null, lots([]), BLOCK_EXPIRED, TODAY)).toEqual({ kind: "ELIGIBLE" });
    });

    it("refuses expired stock under BLOCK and permits it under ALLOW", () => {
      const map = lots([[1, { expiryDate: "2026-08-01" }]]);
      expect(verdictFor(1, map, BLOCK_EXPIRED, TODAY)).toEqual({
        kind: "REFUSED",
        reason: "EXPIRED",
      });
      expect(
        verdictFor(1, map, { ...BLOCK_EXPIRED, expiryPolicy: "ALLOW" }, TODAY),
      ).toEqual({ kind: "ELIGIBLE" });
    });
  });

  describe("short-dated stock", () => {
    const shortDated = lots([[1, { expiryDate: "2026-09-10" }]]);

    it("is ordinary under ALLOW — the previous behaviour, unchanged", () => {
      expect(verdictFor(1, shortDated, BLOCK_EXPIRED, TODAY)).toEqual({ kind: "ELIGIBLE" });
    });

    it("is taken last under DEPRIORITIZE, but is still allocatable", () => {
      const verdict = verdictFor(
        1,
        shortDated,
        { ...BLOCK_EXPIRED, nearExpiryPolicy: "DEPRIORITIZE" },
        TODAY,
      );
      expect(verdict).toEqual({ kind: "DEPRIORITIZED", reason: "NEAR_EXPIRY" });
      // The distinction that matters: deprioritized is not refused. A line that
      // only short-dated stock can cover still gets filled.
      expect(verdict.kind).not.toBe("REFUSED");
    });

    it("is refused under BLOCK, and that refusal is the overridable one", () => {
      const verdict = verdictFor(
        1,
        shortDated,
        { ...BLOCK_EXPIRED, nearExpiryPolicy: "BLOCK" },
        TODAY,
      );
      expect(verdict).toEqual({ kind: "REFUSED", reason: "NEAR_EXPIRY" });
      expect(overridable(verdict)).toBe(true);
    });
  });

  describe("what an override may reach", () => {
    it("cannot wave through an expired, recalled, blocked or consumed lot", () => {
      // If it could, `expiryReservationPolicy: BLOCK` would be a suggestion.
      expect(overridable({ kind: "REFUSED", reason: "EXPIRED" })).toBe(false);
      expect(overridable({ kind: "REFUSED", reason: "LOT_STATUS" })).toBe(false);
    });

    it("has nothing to do on a lot the allocator would have chosen anyway", () => {
      expect(overridable({ kind: "ELIGIBLE" })).toBe(false);
    });

    it("reaches short-dated stock, whether it was blocked or merely deprioritized", () => {
      expect(overridable({ kind: "REFUSED", reason: "NEAR_EXPIRY" })).toBe(true);
      expect(overridable({ kind: "DEPRIORITIZED", reason: "NEAR_EXPIRY" })).toBe(true);
    });

    it("reaches a shelf-life refusal — a customer can agree to short stock on the day", () => {
      expect(overridable({ kind: "REFUSED", reason: "SHELF_LIFE" })).toBe(true);
    });

    it("names the rule it would set aside, so the record can say which one", () => {
      // The override record stores this verbatim. A single "overridden" flag
      // cannot distinguish an organisation's own caution from a broken contract,
      // and those are the two things a reviewer is trying to tell apart.
      expect(overriddenRule({ kind: "REFUSED", reason: "SHELF_LIFE" })).toBe("SHELF_LIFE");
      expect(overriddenRule({ kind: "REFUSED", reason: "NEAR_EXPIRY" })).toBe("NEAR_EXPIRY");
      expect(overriddenRule({ kind: "DEPRIORITIZED", reason: "NEAR_EXPIRY" })).toBe("NEAR_EXPIRY");
      expect(overriddenRule({ kind: "REFUSED", reason: "EXPIRED" })).toBeNull();
      expect(overriddenRule({ kind: "ELIGIBLE" })).toBeNull();
    });
  });

  describe("the customer's contracted minimum shelf life", () => {
    /** 90 days out: comfortably outside a 30-day near-expiry window. */
    const ninetyDays = lots([[1, { expiryDate: "2026-11-27" }]]);
    const withFloor = (days: number): EligibilityPolicy => ({
      ...BLOCK_EXPIRED,
      minShelfLifeDays: days,
    });

    it("refuses a lot the near-expiry window has no opinion about", () => {
      // The case the whole second number exists for. This lot is not
      // short-dated by any org setting — and a customer contracted for 120 days.
      expect(isNearExpiry({ expiryDate: "2026-11-27", status: "ACTIVE" }, 30, TODAY)).toBe(false);
      expect(verdictFor(1, ninetyDays, withFloor(120), TODAY)).toEqual({
        kind: "REFUSED",
        reason: "SHELF_LIFE",
      });
    });

    it("passes the same lot for a customer who contracted for less", () => {
      // Same shelf, same day, same lot — a different answer per destination,
      // which is the thing no ordering rule and no tenant-wide setting can do.
      expect(verdictFor(1, ninetyDays, withFloor(60), TODAY)).toEqual({ kind: "ELIGIBLE" });
    });

    it("includes the floor day itself: exactly the agreed shelf life is enough", () => {
      expect(verdictFor(1, ninetyDays, withFloor(90), TODAY)).toEqual({ kind: "ELIGIBLE" });
      expect(verdictFor(1, ninetyDays, withFloor(91), TODAY)).toEqual({
        kind: "REFUSED",
        reason: "SHELF_LIFE",
      });
    });

    it("means nothing at zero — no rule is no floor, not a floor of none", () => {
      expect(verdictFor(1, ninetyDays, withFloor(0), TODAY)).toEqual({ kind: "ELIGIBLE" });
    });

    it("has no opinion on a lot with no expiry date", () => {
      const undated = lots([[1, { expiryDate: null }]]);
      expect(verdictFor(1, undated, withFloor(3650), TODAY)).toEqual({ kind: "ELIGIBLE" });
    });

    it("outranks DEPRIORITIZE: a contract is not a preference", () => {
      // Under the org's own policy alone this lot would be allocatable-but-last.
      // The floor removes it from the set instead, which is the distinction
      // between an operational preference and a term of a supply agreement.
      const shortAndBelowFloor = lots([[1, { expiryDate: "2026-09-10" }]]);
      const policy: EligibilityPolicy = {
        ...BLOCK_EXPIRED,
        nearExpiryPolicy: "DEPRIORITIZE",
        minShelfLifeDays: 60,
      };
      expect(verdictFor(1, shortAndBelowFloor, policy, TODAY)).toEqual({
        kind: "REFUSED",
        reason: "SHELF_LIFE",
      });
    });

    it("leaves a customer's floor overridable even on an expired lot, where the org allows expired stock", () => {
      // The organisation has set ALLOW: it has decided expired stock may be
      // allocated. The only thing refusing this lot is one customer's
      // contracted floor, which is a judgement call between a seller and a
      // buyer and can be waived on the day.
      //
      // This returned EXPIRED once, which `overridable()` refuses -- so adding
      // a floor for one customer silently converted the organisation's own
      // ALLOW into a hard refusal nobody could pass, and the operator was told
      // "expired stock is not an allocation decision" by a tenant that had
      // decided exactly that it was.
      const expired = lots([[1, { expiryDate: "2026-08-01" }]]);
      const verdict = verdictFor(
        1,
        expired,
        { ...BLOCK_EXPIRED, expiryPolicy: "ALLOW", minShelfLifeDays: 30 },
        TODAY,
      );
      expect(verdict).toEqual({ kind: "REFUSED", reason: "SHELF_LIFE" });
      expect(overridable(verdict)).toBe(true);
    });

    it("still refuses an expired lot outright under BLOCK, floor or no floor", () => {
      // The other half of the same rule, and the one that must not have been
      // weakened by the change above: BLOCK is enforced before the floor is
      // ever consulted, so it says what it says whether or not the customer
      // has a contract.
      const expired = lots([[1, { expiryDate: "2026-08-01" }]]);
      for (const floor of [0, 30]) {
        const verdict = verdictFor(
          1,
          expired,
          { ...BLOCK_EXPIRED, expiryPolicy: "BLOCK", minShelfLifeDays: floor },
          TODAY,
        );
        expect({ floor, verdict }).toEqual({
          floor,
          verdict: { kind: "REFUSED", reason: "EXPIRED" },
        });
        expect(overridable(verdict)).toBe(false);
      }
    });
  });

  describe("days remaining, as an override record snapshots it", () => {
    it("counts whole days forward and backward from today", () => {
      expect(daysRemaining("2026-09-28", TODAY)).toBe(30);
      expect(daysRemaining(TODAY, TODAY)).toBe(0);
      expect(daysRemaining("2026-08-01", TODAY)).toBe(-28);
    });
  });

  describe("FEFO and near-expiry are not in conflict", () => {
    it("puts the soonest-expiring lot first within a tier, and the tier first overall", () => {
      // Three lots: one short-dated, two not. FEFO alone would pick the
      // short-dated one, because it expires soonest. Tiering means it goes last
      // and FEFO still orders the two that remain.
      const map = lots([
        [1, { expiryDate: "2026-09-05" }], // short-dated
        [2, { expiryDate: "2026-12-01" }],
        [3, { expiryDate: "2026-10-15" }],
      ]);
      const policy: EligibilityPolicy = {
        ...BLOCK_EXPIRED,
        nearExpiryPolicy: "DEPRIORITIZE",
        nearExpiryWindowDays: 30,
      };

      const tier = (id: number) =>
        verdictFor(id, map, policy, TODAY).kind === "DEPRIORITIZED" ? 1 : 0;
      const expiry = (id: number) => map.get(id)!.expiryDate!;

      const ordered = [1, 2, 3].sort(
        (a, b) => tier(a) - tier(b) || (expiry(a) < expiry(b) ? -1 : 1),
      );

      // 3 (Oct, not short-dated), 2 (Dec, not short-dated), then 1 (Sep, short-dated).
      expect(ordered).toEqual([3, 2, 1]);
    });
  });
});
