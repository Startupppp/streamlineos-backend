import {
  isNearExpiry,
  nearExpiryHorizon,
  overridable,
  verdictFor,
  type EligibilityPolicy,
  type LotFacts,
} from "../lot-eligibility";

/**
 * D2 — the three questions, and the proof they stay apart.
 *
 * INV-402 was one collapse of these (eligibility hidden inside the FEFO branch,
 * so every other strategy shipped expired stock). This adds a second axis, and
 * a second axis is a second chance to collapse them — so the tension is asserted
 * directly: FEFO wants the soonest-expiring lot first, near-expiry policy wants
 * it last, and both are satisfied because they answer different questions.
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
