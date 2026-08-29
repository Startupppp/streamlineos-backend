import {
  makeTouchKey,
  normaliseChannel,
  orderTouches,
  touchesUpTo,
  type AttributionTouch,
} from "./attribution-touch";

describe("attribution-touch", () => {
  describe("makeTouchKey", () => {
    it("namespaces keys cleanly by touch kind", () => {
      expect(makeTouchKey("touchpoint", "123")).toBe("touchpoint:123");
      expect(makeTouchKey("activity", 456)).toBe("activity:456");
    });
  });

  describe("normaliseChannel", () => {
    it("lowercases and collapses whitespace", () => {
      expect(normaliseChannel("  Organic   Search ")).toBe("organic search");
      expect(normaliseChannel("EMAIL")).toBe("email");
    });

    it("falls back to specified fallback when empty or null", () => {
      expect(normaliseChannel(null)).toBe("unknown");
      expect(normaliseChannel("")).toBe("unknown");
      expect(normaliseChannel("   ", "direct")).toBe("direct");
    });
  });

  describe("orderTouches", () => {
    it("orders chronologically and tie-breaks with touchKey", () => {
      const t1: AttributionTouch = {
        touchKey: "touchpoint:b",
        touchKind: "touchpoint",
        channel: "email",
        campaignId: null,
        occurredAt: new Date("2026-08-01T12:00:00Z"),
        detail: null,
      };
      const t2: AttributionTouch = {
        touchKey: "touchpoint:a",
        touchKind: "touchpoint",
        channel: "email",
        campaignId: null,
        occurredAt: new Date("2026-08-01T12:00:00Z"),
        detail: null,
      };
      const t3: AttributionTouch = {
        touchKey: "activity:1",
        touchKind: "activity",
        channel: "call",
        campaignId: null,
        occurredAt: new Date("2026-08-02T12:00:00Z"),
        detail: null,
      };

      const ordered = orderTouches([t3, t1, t2]);
      expect(ordered[0].touchKey).toBe("touchpoint:a");
      expect(ordered[1].touchKey).toBe("touchpoint:b");
      expect(ordered[2].touchKey).toBe("activity:1");
    });
  });

  describe("touchesUpTo", () => {
    it("filters out touches occurring strictly after asOf", () => {
      const asOf = new Date("2026-08-10T00:00:00Z");
      const before: AttributionTouch = {
        touchKey: "touchpoint:1",
        touchKind: "touchpoint",
        channel: "ad",
        campaignId: 1,
        occurredAt: new Date("2026-08-05T00:00:00Z"),
        detail: null,
      };
      const at: AttributionTouch = {
        touchKey: "activity:1",
        touchKind: "activity",
        channel: "call",
        campaignId: null,
        occurredAt: new Date("2026-08-10T00:00:00Z"),
        detail: null,
      };
      const after: AttributionTouch = {
        touchKey: "activity:2",
        touchKind: "activity",
        channel: "call",
        campaignId: null,
        occurredAt: new Date("2026-08-11T00:00:00Z"),
        detail: null,
      };

      const filtered = touchesUpTo([before, at, after], asOf);
      expect(filtered).toEqual([before, at]);
    });
  });
});
