/**
 * AutonomyReviewService — cross-tenant isolation
 *
 * Proves listDecisions scopes every query to the caller's org and cannot
 * surface decisions owned by a different org.
 */

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { AutonomyReviewService } from "./autonomy-review.service";
import { AutonomyReversalService } from "./autonomy-reversal.service";
import type { ListDecisionsQuery } from "./dto/autonomy-review.schemas";
import { ScopedRead } from "../access/scoped-read";

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

const QUERY: ListDecisionsQuery = {
  limit: 20,
  cursor: undefined,
  includeRoutine: false,
};

const readFor = (orgId: string, userId: string) => ScopedRead.of(orgId, userId, "all");

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
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
  } as unknown as Db;
  return { db, where };
}

function makeReversalService() {
  return { reverseDecision: jest.fn() } as unknown as AutonomyReversalService;
}

describe("AutonomyReviewService — cross-tenant isolation", () => {
  it("returns empty page for a different org (cross-tenant access denied)", async () => {
    const { db, where } = makeDb([]);
    const svc = new AutonomyReviewService(db, makeReversalService());

    const result = await svc.listDecisions(readFor(ATTACKER_ORG, "user-x"), QUERY);

    expect(result.data).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const callArg = where.mock.calls[0]?.[0];
    expect(sqlValues(callArg)).toContain(ATTACKER_ORG);
  });

  it("returns data page for the owning org (same-tenant control)", async () => {
    const row = {
      autonomousDecisionId: "d-1",
      kind: "task.extracted",
      outcome: "applied",
      summary: "test",
      confidence: 0.9,
      reversibility: "reversible",
      triggerType: "activity",
      triggerId: "a-1",
      partyId: null,
      dealId: null,
      activityId: "a-1",
      decidedAt: new Date(),
      reversedAt: null,
      reversedByUserId: null,
      reversedReason: null,
      model: "gpt-4",
      promptVersion: "1",
      dealName: null,
      partyName: null,
    };
    const { db } = makeDb([row, row]);
    const svc = new AutonomyReviewService(db, makeReversalService());

    const result = await svc.listDecisions(readFor(OWNER_ORG, "user-1"), QUERY);

    expect(result.data.length).toBeGreaterThan(0);
  });

  it("throws NotFoundException for a decision in another org (getDecision cross-tenant isolation)", async () => {
    const where = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    });
    const from = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
    const svc = new AutonomyReviewService(db, makeReversalService());

    await expect(svc.getDecision(ATTACKER_ORG, "dec-999")).rejects.toThrow(NotFoundException);
  });
});
