import type { StageMove } from "./deal-forecast-features";
import {
  FORECAST_TRAINING_HORIZON_DAYS,
  buildHistoricalRates,
  countOutcomes,
  movesBefore,
  stageAt,
  trainingAsOf,
  type ClosedDealRecord,
} from "./training-examples";

const DAY = 86_400_000;
const CLOSED = new Date("2026-06-30T00:00:00.000Z");

function at(daysBeforeClose: number): Date {
  return new Date(CLOSED.getTime() - daysBeforeClose * DAY);
}

function move(from: string | null, to: string, daysBeforeClose: number): StageMove {
  return { fromStage: from, toStage: to, occurredAt: at(daysBeforeClose) };
}

function closedDeal(
  dealId: number,
  outcome: "won" | "lost",
  overrides: Partial<ClosedDealRecord> = {},
): ClosedDealRecord {
  return {
    dealId,
    createdAt: at(200),
    closedAt: CLOSED,
    outcome,
    assignedToId: "rep-1",
    sourceKey: "referral",
    ...overrides,
  };
}

describe("trainingAsOf", () => {
  it("looks at the deal a horizon before it closed", () => {
    expect(trainingAsOf(at(200), CLOSED)).toEqual(at(FORECAST_TRAINING_HORIZON_DAYS));
  });

  it("never looks before the deal existed", () => {
    expect(trainingAsOf(at(8), CLOSED)).toEqual(at(8));
  });

  it("uses the close itself for a deal created and closed the same day", () => {
    expect(trainingAsOf(CLOSED, CLOSED)).toEqual(CLOSED);
  });

  it("takes the horizon as an argument so a caller can widen it", () => {
    expect(trainingAsOf(at(200), CLOSED, 90)).toEqual(at(90));
  });
});

describe("stageAt", () => {
  const LEDGER: StageMove[] = [
    move(null, "LEAD", 180),
    move("LEAD", "CONTACTED", 120),
    move("CONTACTED", "PROPOSAL", 60),
    move("PROPOSAL", "WON", 0),
  ];

  /**
   * The whole point. At the close the stage is WON, which is the answer; thirty
   * days earlier it is PROPOSAL, which is a question.
   */
  it("does not report the terminal stage at the training moment", () => {
    expect(stageAt(LEDGER, CLOSED, "WON")).toBe("WON");
    expect(stageAt(LEDGER, at(30), "WON")).toBe("PROPOSAL");
  });

  it("reads the stage a deal landed in as of that moment", () => {
    expect(stageAt(LEDGER, at(150), "WON")).toBe("LEAD");
    expect(stageAt(LEDGER, at(90), "WON")).toBe("CONTACTED");
  });

  it("looks forward to the stage a later move came from when nothing came before", () => {
    expect(stageAt([move("LEAD", "CONTACTED", 100)], at(150), "WON")).toBe("LEAD");
  });

  it("uses the later move's destination when even that says nothing", () => {
    expect(stageAt([move(null, "LEAD", 100)], at(150), "WON")).toBe("LEAD");
  });

  it("falls back to the deal's own stage when it has no ledger at all", () => {
    expect(stageAt([], at(30), "NEGOTIATION")).toBe("NEGOTIATION");
  });

  it("does not depend on the order the ledger arrives in", () => {
    expect(stageAt([...LEDGER].reverse(), at(30), "WON")).toBe("PROPOSAL");
  });
});

describe("movesBefore", () => {
  it("keeps only what had happened, oldest first", () => {
    const ledger = [move("CONTACTED", "PROPOSAL", 60), move(null, "LEAD", 180), move("PROPOSAL", "WON", 0)];

    expect(movesBefore(ledger, at(30)).map((m) => m.toStage)).toEqual(["LEAD", "PROPOSAL"]);
  });

  it("returns nothing for a moment before the deal moved at all", () => {
    expect(movesBefore([move(null, "LEAD", 10)], at(30))).toEqual([]);
  });
});

describe("buildHistoricalRates", () => {
  it("counts the tenant's own outcomes by rep and by source", () => {
    const rates = buildHistoricalRates([
      closedDeal(1, "won"),
      closedDeal(2, "lost"),
      closedDeal(3, "won", { assignedToId: "rep-2", sourceKey: "web" }),
      closedDeal(4, "lost", { assignedToId: "rep-2", sourceKey: "web" }),
      closedDeal(5, "lost", { assignedToId: "rep-2", sourceKey: "web" }),
    ]);

    expect(rates.baseline).toEqual({ won: 2, total: 5 });
    expect(rates.byRep.get("rep-1")).toEqual({ won: 1, total: 2 });
    expect(rates.byRep.get("rep-2")).toEqual({ won: 1, total: 3 });
    expect(rates.bySource.get("web")).toEqual({ won: 1, total: 3 });
  });

  it("does not invent a group for an unassigned or unsourced deal", () => {
    const rates = buildHistoricalRates([
      closedDeal(1, "won", { assignedToId: null, sourceKey: null }),
    ]);

    expect(rates.byRep.size).toBe(0);
    expect(rates.bySource.size).toBe(0);
    expect(rates.baseline).toEqual({ won: 1, total: 1 });
  });

  it("returns an empty history for no deals rather than a divide by zero", () => {
    expect(buildHistoricalRates([]).baseline).toEqual({ won: 0, total: 0 });
  });
});

describe("countOutcomes", () => {
  it("splits the history into the two numbers the threshold is checked against", () => {
    expect(
      countOutcomes([closedDeal(1, "won"), closedDeal(2, "lost"), closedDeal(3, "lost")]),
    ).toEqual({ won: 1, lost: 2 });
  });
});
