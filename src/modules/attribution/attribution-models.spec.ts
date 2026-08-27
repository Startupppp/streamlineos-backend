import {
  ATTRIBUTION_MODELS,
  POSITION_BASED_FIRST,
  TIME_DECAY_HALF_LIFE_DAYS,
  type AttributionModelId,
} from "./attribution-models";
import { attributeConversion, BPS } from "./attribution-projection";
import type { AttributionTouch, Conversion } from "./attribution-touch";

const CLOSED = new Date("2026-03-31T12:00:00.000Z");
const DAY_MS = 86_400_000;

const conversion: Conversion = {
  dealId: "1",
  organizationId: "org-1",
  currency: "GBP",
  valueMinor: 1_000_000,
  convertedAt: CLOSED,
};

function touch(id: string, daysBeforeClose: number, channel = "manual"): AttributionTouch {
  return {
    activityId: id,
    occurredAt: new Date(CLOSED.getTime() - daysBeforeClose * DAY_MS),
    kind: "email",
    channel,
    partyId: "party-1",
    dealId: "1",
  };
}

/** Four touches, a month apart at the top and a day apart at the bottom. */
const timeline: readonly AttributionTouch[] = [
  touch("a", 60, "campaign"),
  touch("b", 30, "email"),
  touch("c", 7, "call"),
  touch("d", 1, "call"),
];

function creditFor(model: AttributionModelId, activityId: string): number {
  const attributed = attributeConversion(conversion, timeline, model);
  return attributed.credits.find((credit) => credit.activityId === activityId)?.creditMinor ?? 0;
}

describe("what each attribution model actually pays out", () => {
  it("gives first-touch the whole deal to the earliest touch and nothing to the rest", () => {
    const attributed = attributeConversion(conversion, timeline, "first-touch");

    expect(attributed.credits.map((credit) => credit.creditMinor)).toEqual([
      1_000_000, 0, 0, 0,
    ]);
  });

  it("gives last-touch the whole deal to the touch immediately before the close", () => {
    const attributed = attributeConversion(conversion, timeline, "last-touch");

    expect(attributed.credits.map((credit) => credit.creditMinor)).toEqual([
      0, 0, 0, 1_000_000,
    ]);
  });

  it("splits linear evenly, to the minor unit", () => {
    const attributed = attributeConversion(conversion, timeline, "linear");

    expect(attributed.credits.map((credit) => credit.creditMinor)).toEqual([
      250_000, 250_000, 250_000, 250_000,
    ]);
  });

  it("pays time-decay half as much for a touch one half-life older", () => {
    const older = touch("older", TIME_DECAY_HALF_LIFE_DAYS * 2);
    const newer = touch("newer", TIME_DECAY_HALF_LIFE_DAYS);

    // A value the two weights (1/4 and 1/2, so a 1:2 split) divide exactly, so
    // the claim under test is the decay and not the remainder rule.
    const divisible: Conversion = { ...conversion, valueMinor: 900_000 };
    const attributed = attributeConversion(divisible, [older, newer], "time-decay");
    const [olderCredit, newerCredit] = attributed.credits.map((credit) => credit.creditMinor);

    expect(newerCredit).toBe(olderCredit * 2);
    expect(olderCredit + newerCredit).toBe(divisible.valueMinor);
  });

  it("gives position-based its stated share to the first touch", () => {
    const attributed = attributeConversion(conversion, timeline, "position-based");

    expect(attributed.credits[0].creditMinor).toBe(
      (conversion.valueMinor * POSITION_BASED_FIRST) / 100,
    );
    expect(attributed.credits[0].creditBps).toBe(POSITION_BASED_FIRST * 100);
  });

  it("gives a lone touch everything under position-based, leaving no middle share stranded", () => {
    const attributed = attributeConversion(conversion, [touch("only", 5)], "position-based");

    expect(attributed.credits.map((credit) => credit.creditMinor)).toEqual([1_000_000]);
    expect(attributed.unattributedMinor).toBe(0);
  });

  it("splits two touches evenly under position-based, because both are ends", () => {
    const attributed = attributeConversion(
      conversion,
      [touch("first", 20), touch("last", 2)],
      "position-based",
    );

    expect(attributed.credits.map((credit) => credit.creditMinor)).toEqual([500_000, 500_000]);
  });

  it("disagrees between models about the same deal, which is the point of having more than one", () => {
    const firstTouchShare = creditFor("first-touch", "a");
    const lastTouchShare = creditFor("last-touch", "a");

    expect(firstTouchShare).toBe(1_000_000);
    expect(lastTouchShare).toBe(0);
  });

  it("attributes the whole deal under every model and never more than it", () => {
    for (const model of ATTRIBUTION_MODELS) {
      const attributed = attributeConversion(conversion, timeline, model);
      const paid = attributed.credits.reduce((total, credit) => total + credit.creditMinor, 0);
      const shares = attributed.credits.reduce((total, credit) => total + credit.creditBps, 0);

      expect(paid).toBe(conversion.valueMinor);
      expect(shares).toBe(BPS);
      expect(attributed.unattributedMinor).toBe(0);
    }
  });

  it("credits only touches that were on the timeline, under every model", () => {
    const onTheTimeline = new Set(timeline.map((entry) => entry.activityId));

    for (const model of ATTRIBUTION_MODELS) {
      const attributed = attributeConversion(conversion, timeline, model);
      const credited = attributed.credits.map((credit) => credit.activityId);

      expect(credited.every((activityId) => onTheTimeline.has(activityId))).toBe(true);
      expect(credited.length).toBeLessThanOrEqual(timeline.length);
    }
  });
});
