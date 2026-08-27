import { ATTRIBUTION_MODELS } from "./attribution-models";
import {
  apportion,
  attributeConversion,
  summariseByChannel,
  AttributionError,
  BPS,
  MAX_TOUCHES_PER_CONVERSION,
} from "./attribution-projection";
import type { AttributionTouch, Conversion } from "./attribution-touch";

const CLOSED = new Date("2026-06-30T09:00:00.000Z");
const DAY_MS = 86_400_000;

const conversion: Conversion = {
  dealId: "77",
  organizationId: "org-1",
  currency: "GBP",
  valueMinor: 100_003,
  convertedAt: CLOSED,
};

function touch(id: string, daysBeforeClose: number, channel = "manual"): AttributionTouch {
  return {
    activityId: id,
    occurredAt: new Date(CLOSED.getTime() - daysBeforeClose * DAY_MS),
    kind: "call",
    channel,
    partyId: "party-1",
    dealId: "77",
  };
}

describe("apportioning money across touches", () => {
  it("hands out every minor unit, including the ones that do not divide", () => {
    const shares = apportion(100_003, [1, 1, 1]);

    expect(shares.reduce((total, share) => total + share, 0)).toBe(100_003);
    expect(shares).toEqual([33_335, 33_334, 33_334]);
  });

  it("gives a leftover unit to whoever was closest to earning it, not to whoever is first", () => {
    // Exact shares are 0.9, 4.5 and 4.6 of ten units.
    expect(apportion(10, [9, 45, 46])).toEqual([1, 4, 5]);
  });

  it("returns the same answer twice for the same input, so a figure does not move between reads", () => {
    const once = apportion(1_000_001, [3, 3, 3, 3, 3, 3, 3]);
    const twice = apportion(1_000_001, [3, 3, 3, 3, 3, 3, 3]);

    expect(once).toEqual(twice);
  });

  it("pays nobody when a model says nobody earned anything, rather than splitting evenly", () => {
    expect(apportion(500, [0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("a credit always names the timeline row it came from", () => {
  it("refuses a touch with no activity id", () => {
    const ghost: AttributionTouch = { ...touch("", 5), activityId: "" };

    expect(() => attributeConversion(conversion, [ghost], "linear")).toThrow(AttributionError);
  });

  it("refuses to credit the same activity twice", () => {
    const duplicated = [touch("a", 10), touch("a", 3)];

    expect(() => attributeConversion(conversion, duplicated, "linear")).toThrow(
      /twice/,
    );
  });

  it("credits nothing when the timeline is empty, and says the revenue is unattributed", () => {
    const attributed = attributeConversion(conversion, [], "linear");

    expect(attributed.credits).toEqual([]);
    expect(attributed.unattributedMinor).toBe(conversion.valueMinor);
  });

  it("ignores a touch made after the deal closed", () => {
    const afterwards: AttributionTouch = {
      ...touch("later", 0),
      occurredAt: new Date(CLOSED.getTime() + DAY_MS),
    };

    const attributed = attributeConversion(
      conversion,
      [touch("before", 4), afterwards],
      "last-touch",
    );

    expect(attributed.credits.map((credit) => credit.activityId)).toEqual(["before"]);
  });

  it("says so on the figure when the timeline was longer than it will read", () => {
    const long = Array.from({ length: MAX_TOUCHES_PER_CONVERSION + 5 }, (_, index) =>
      touch(`t${String(index).padStart(5, "0")}`, MAX_TOUCHES_PER_CONVERSION + 5 - index),
    );

    const attributed = attributeConversion(conversion, long, "linear");

    expect(attributed.truncated).toBe(true);
    expect(attributed.credits).toHaveLength(MAX_TOUCHES_PER_CONVERSION);
  });
});

describe("a figure decomposes to the touches that produced it", () => {
  const timeline = [
    touch("a", 40, "campaign"),
    touch("b", 12, "email"),
    touch("c", 2, "call"),
  ];

  it("adds its parts back up to the whole, under every model", () => {
    for (const model of ATTRIBUTION_MODELS) {
      const attributed = attributeConversion(conversion, timeline, model);
      const parts = attributed.credits.reduce((total, credit) => total + credit.creditMinor, 0);

      expect(parts + attributed.unattributedMinor).toBe(attributed.valueMinor);
    }
  });

  it("states its model and version on the figure itself", () => {
    const attributed = attributeConversion(conversion, timeline, "time-decay");

    expect(attributed.model).toBe("time-decay");
    expect(attributed.modelVersion).toBeGreaterThan(0);
  });

  it("carries enough on each credit to find the touch in the timeline", () => {
    const attributed = attributeConversion(conversion, timeline, "linear");

    expect(attributed.credits.map((credit) => credit.activityId)).toEqual(["a", "b", "c"]);
    expect(attributed.credits.map((credit) => credit.channel)).toEqual([
      "campaign",
      "email",
      "call",
    ]);
  });
});

describe("changing the model re-presents history rather than rewriting it", () => {
  const timeline = [touch("a", 40, "campaign"), touch("b", 12, "email"), touch("c", 2, "call")];

  it("leaves the touches it was given exactly as it found them", () => {
    const before = JSON.stringify(timeline);

    for (const model of ATTRIBUTION_MODELS) attributeConversion(conversion, timeline, model);

    expect(JSON.stringify(timeline)).toBe(before);
  });

  it("gives the same answer again after a different model has been asked for", () => {
    const first = attributeConversion(conversion, timeline, "first-touch");
    attributeConversion(conversion, timeline, "time-decay");
    attributeConversion(conversion, timeline, "position-based");
    const again = attributeConversion(conversion, timeline, "first-touch");

    expect(again).toEqual(first);
  });

  it("moves the same total between touches rather than changing what the deal was worth", () => {
    const totals = ATTRIBUTION_MODELS.map((model) => {
      const attributed = attributeConversion(conversion, timeline, model);
      return attributed.credits.reduce((total, credit) => total + credit.creditMinor, 0);
    });

    expect(new Set(totals).size).toBe(1);
    expect(totals[0]).toBe(conversion.valueMinor);
  });
});

describe("rolling attributed deals up by channel", () => {
  const first = attributeConversion(
    { ...conversion, dealId: "1", valueMinor: 300_000 },
    [touch("a", 30, "campaign"), touch("b", 4, "email")],
    "linear",
  );
  const second = attributeConversion(
    { ...conversion, dealId: "2", valueMinor: 100_001 },
    [touch("c", 20, "email")],
    "linear",
  );

  it("shares that total exactly one hundred per cent, however the money divides", () => {
    const report = summariseByChannel("linear", "GBP", [first, second]);
    const shares = report.byChannel.reduce((total, share) => total + share.creditBps, 0);

    expect(shares).toBe(BPS);
  });

  it("puts each channel's money where the credits put it", () => {
    const report = summariseByChannel("linear", "GBP", [first, second]);
    const email = report.byChannel.find((share) => share.channel === "email");

    expect(email?.creditMinor).toBe(150_000 + 100_001);
    expect(email?.deals).toBe(2);
  });

  it("refuses to total deals attributed under different models", () => {
    const other = attributeConversion(
      { ...conversion, dealId: "3", valueMinor: 500 },
      [touch("d", 3, "call")],
      "last-touch",
    );

    expect(() => summariseByChannel("linear", "GBP", [first, other])).toThrow(AttributionError);
  });

  it("keeps unattributed revenue visible in the total rather than folding it into a channel", () => {
    const untouched = attributeConversion(
      { ...conversion, dealId: "4", valueMinor: 900 },
      [],
      "linear",
    );
    const report = summariseByChannel("linear", "GBP", [first, untouched]);

    expect(report.unattributedMinor).toBe(900);
    expect(report.attributedMinor).toBe(300_000);
    expect(report.totalMinor).toBe(300_900);
  });
});
