import { AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD } from "../party/party-duplicates";
import type { FindingSeverity } from "../../db/schema/crm/data-quality";
import {
  duplicateGroupKey,
  duplicateSeverity,
  stalenessBand,
  stalenessGroupKey,
  strongestSignal,
} from "./producer-bands";

/**
 * The invariant the grouped view depends on: **`groupKey` determines
 * `severity`**.
 *
 * `listGroups` is a single `GROUP BY` over both columns. If a group could hold
 * two severities it would come back twice and ask a person the same question at
 * two severities — which is exactly the four-hundred-decisions problem this
 * ticket exists to remove, reintroduced one level up.
 */
describe("producer bands", () => {
  describe("duplicateSeverity", () => {
    it("reuses the detector's own thresholds rather than new numbers", () => {
      expect(duplicateSeverity(AUTO_MERGE_THRESHOLD)).toBe("high");
      expect(duplicateSeverity(AUTO_MERGE_THRESHOLD - 0.0001)).not.toBe("high");
      expect(duplicateSeverity(REVIEW_THRESHOLD)).toBe("low");
    });

    it("is monotonic — a stronger score is never a milder severity", () => {
      const rank: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2 };
      let previous = -1;
      for (let score = 0; score <= 1.0001; score += 0.01) {
        const current = rank[duplicateSeverity(Math.min(score, 1))];
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    });
  });

  describe("strongestSignal", () => {
    it("prefers a registration number to a name", () => {
      expect(strongestSignal(["name-close", "tax-number"])).toBe("tax-number");
    });

    it("prefers an address to a domain", () => {
      expect(strongestSignal(["email-domain", "email"])).toBe("email");
    });

    it("says so rather than guessing when it recognises nothing", () => {
      expect(strongestSignal([])).toBe("unknown");
      expect(strongestSignal(["something-new"])).toBe("unknown");
    });
  });

  /**
   * Two pairs matched on a name and two matched on a tax number are not one
   * decision, however similar their scores. Merging on a name alone is the false
   * merge `party-duplicates` is weighted to avoid, so it must not be able to
   * ride into a bulk apply behind a stronger signal.
   */
  it("keeps different signals in different groups", () => {
    expect(duplicateGroupKey(["tax-number"], "high")).not.toEqual(
      duplicateGroupKey(["name-close"], "high"),
    );
  });

  it("keeps different severities in different groups", () => {
    expect(duplicateGroupKey(["tax-number"], "high")).not.toEqual(
      duplicateGroupKey(["tax-number"], "medium"),
    );
  });

  it("gives one group key to every duplicate pair with the same signal and band", () => {
    const scores = [0.9, 0.95, 1];
    const keys = new Set(
      scores.map((score) => duplicateGroupKey(["tax-number"], duplicateSeverity(score))),
    );
    expect(keys.size).toBe(1);
  });

  describe("stalenessBand", () => {
    it("bands relative to the tenant's own threshold, not absolute days", () => {
      expect(stalenessBand(200, 180).severity).toBe("low");
      expect(stalenessBand(200, 30).severity).toBe("high");
    });

    it("escalates at two and three times the threshold", () => {
      expect(stalenessBand(180, 180)).toEqual({ band: "180d+", severity: "low" });
      expect(stalenessBand(360, 180)).toEqual({ band: "360d+", severity: "medium" });
      expect(stalenessBand(540, 180)).toEqual({ band: "540d+", severity: "high" });
    });

    /** The whole reason the band is in the key rather than beside it. */
    it("gives one band exactly one severity", () => {
      const bands = new Map<string, FindingSeverity>();
      for (let quiet = 0; quiet <= 2000; quiet += 7) {
        const { band, severity } = stalenessBand(quiet, 180);
        const seen = bands.get(stalenessGroupKey(band));
        if (seen !== undefined) expect(seen).toBe(severity);
        bands.set(stalenessGroupKey(band), severity);
      }
      expect(bands.size).toBe(3);
    });
  });
});
