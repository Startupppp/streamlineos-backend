/**
 * AutonomyHoldService — cross-tenant isolation
 *
 * Proves liveHolds scopes its query to the caller's org and returns nothing
 * for a foreign org even when holds exist for another org.
 */

import type { Db } from "../../db/drizzle.types";
import { AutonomyHoldService } from "./autonomy-hold.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";
import { NotificationsService } from "../notifications/notifications.service";
import { QuotesService } from "../quotes/quotes.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const HOLD_ROW = {
  autonomyHoldId: "hold-1",
  autonomousDecisionId: "dec-1",
  quoteId: 10,
  holdUntil: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  quoteSubject: "Contract",
  summary: "Sending a quote",
};

function makeDb(rows: unknown[]) {
  const where = jest.fn();
  where.mockReturnValue({
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  });
  const leftJoin = jest.fn().mockReturnThis();
  const from = jest.fn().mockReturnValue({ leftJoin, where });
  const db = {
    select: jest.fn().mockReturnValue({ from }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
  } as unknown as Db;
  return { db, where };
}

function mockDeps() {
  return {
    scoring: {
      settingsFor: jest.fn().mockResolvedValue({ holdWindowSeconds: 300, shadowSampleRate: 0, shadowDailyCap: 0 }),
    } as unknown as AutonomyScoringService,
    notifications: {
      createAndDispatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationsService,
    quotes: {} as unknown as QuotesService,
  };
}

describe("AutonomyHoldService — cross-tenant isolation", () => {
  it("returns no holds for a different org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const { scoring, notifications, quotes } = mockDeps();
    const svc = new AutonomyHoldService(db, scoring, notifications, quotes);

    const result = await svc.liveHolds(ATTACKER_ORG);

    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const callArg = where.mock.calls[0]?.[0];
    expect(sqlValues(callArg)).toContain(ATTACKER_ORG);
  });

  it("returns holds for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([HOLD_ROW]);
    const { scoring, notifications, quotes } = mockDeps();
    const svc = new AutonomyHoldService(db, scoring, notifications, quotes);

    const result = await svc.liveHolds(OWNER_ORG);

    expect(result).toHaveLength(1);
    expect(result[0]?.autonomyHoldId).toBe("hold-1");
  });
});
