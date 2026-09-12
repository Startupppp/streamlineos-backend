import {
  ATTRIBUTION_MODELS,
  ATTRIBUTION_MODEL_DESCRIPTIONS,
  isAttributionModel,
  weightsFor,
  TIME_DECAY_SCALE,
  DEFAULT_HALF_LIFE_DAYS,
  POSITION_END_PERCENT,
  POSITION_MIDDLE_PERCENT,
} from "./attribution-models";
import type { AttributionTouch } from "./attribution-touch";

describe("attribution-models", () => {
  const asOf = new Date("2026-08-15T12:00:00Z");
  const context = { asOf, halfLifeDays: DEFAULT_HALF_LIFE_DAYS };

  const touch1: AttributionTouch = {
    touchKey: "touchpoint:1",
    touchKind: "touchpoint",
    channel: "organic_search",
    campaignId: 101,
    occurredAt: new Date("2026-08-01T12:00:00Z"),
    detail: "Initial search",
  };

  const touch2: AttributionTouch = {
    touchKey: "touchpoint:2",
    touchKind: "touchpoint",
    channel: "email",
    campaignId: 102,
    occurredAt: new Date("2026-08-08T12:00:00Z"),
    detail: "Nurture click",
  };

  const touch3: AttributionTouch = {
    touchKey: "activity:3",
    touchKind: "activity",
    channel: "sales_call",
    campaignId: null,
    occurredAt: new Date("2026-08-15T10:00:00Z"),
    detail: "Demo call",
  };

  describe("model catalog & guard", () => {
    it("recognizes all five standard attribution models", () => {
      expect(ATTRIBUTION_MODELS).toEqual([
        "first_touch",
        "last_touch",
        "linear",
        "time_decay",
        "position_based",
      ]);
      expect(isAttributionModel("first_touch")).toBe(true);
      expect(isAttributionModel("last_touch")).toBe(true);
      expect(isAttributionModel("linear")).toBe(true);
      expect(isAttributionModel("time_decay")).toBe(true);
      expect(isAttributionModel("position_based")).toBe(true);
      expect(isAttributionModel("w_shaped")).toBe(false);
      expect(isAttributionModel("")).toBe(false);
    });

    it("has human-readable descriptions for every model", () => {
      for (const model of ATTRIBUTION_MODELS) {
        expect(ATTRIBUTION_MODEL_DESCRIPTIONS[model]).toBeDefined();
        expect(typeof ATTRIBUTION_MODEL_DESCRIPTIONS[model]).toBe("string");
      }
    });
  });

  describe("first_touch", () => {
    it("gives 1 to first touch and 0 to all others", () => {
      const weights = weightsFor("first_touch", [touch1, touch2, touch3], context);
      expect(weights).toEqual([1, 0, 0]);
    });

    it("works with a single touch", () => {
      const weights = weightsFor("first_touch", [touch1], context);
      expect(weights).toEqual([1]);
    });
  });

  describe("last_touch", () => {
    it("gives 1 to last touch and 0 to all others", () => {
      const weights = weightsFor("last_touch", [touch1, touch2, touch3], context);
      expect(weights).toEqual([0, 0, 1]);
    });

    it("works with a single touch", () => {
      const weights = weightsFor("last_touch", [touch1], context);
      expect(weights).toEqual([1]);
    });
  });

  describe("linear", () => {
    it("gives equal integer weight (1) to every touch", () => {
      const weights = weightsFor("linear", [touch1, touch2, touch3], context);
      expect(weights).toEqual([1, 1, 1]);
    });
  });

  describe("time_decay", () => {
    it("weights touches closer to close higher", () => {
      const weights = weightsFor("time_decay", [touch1, touch2, touch3], context);
      expect(weights[0]).toBeLessThan(weights[1]);
      expect(weights[1]).toBeLessThan(weights[2]);
      expect(weights[2]).toBeGreaterThan(990000);
      expect(weights[2]).toBeLessThanOrEqual(TIME_DECAY_SCALE);
    });

    it("never assigns zero weight even for very old touches", () => {
      const oldTouch: AttributionTouch = {
        touchKey: "touchpoint:0",
        touchKind: "touchpoint",
        channel: "event",
        campaignId: 1,
        occurredAt: new Date("2020-01-01T00:00:00Z"),
        detail: "Old event",
      };
      const weights = weightsFor("time_decay", [oldTouch], context);
      expect(weights[0]).toBeGreaterThanOrEqual(1);
    });
  });

  describe("position_based (40 / 20 / 40)", () => {
    it("assigns single touch full weight [1]", () => {
      const weights = weightsFor("position_based", [touch1], context);
      expect(weights).toEqual([1]);
    });

    it("splits two touches equally [1, 1]", () => {
      const weights = weightsFor("position_based", [touch1, touch2], context);
      expect(weights).toEqual([1, 1]);
    });

    it("applies 40% to ends and 20% to middle for 3 touches", () => {
      const weights = weightsFor("position_based", [touch1, touch2, touch3], context);
      // n=3, middles = 1 -> ends = 40*1 = 40, middle = 20
      expect(weights).toEqual([40, 20, 40]);
    });

    it("handles 4 touches correctly", () => {
      const touch4: AttributionTouch = {
        touchKey: "activity:4",
        touchKind: "activity",
        channel: "chat",
        campaignId: null,
        occurredAt: new Date("2026-08-15T11:00:00Z"),
        detail: "Chat",
      };
      const weights = weightsFor("position_based", [touch1, touch2, touch3, touch4], context);
      // n=4, middles = 2 -> ends = 40*2 = 80, middles = 20 each -> [80, 20, 20, 80]
      expect(weights).toEqual([80, 20, 20, 80]);
    });
  });
});
