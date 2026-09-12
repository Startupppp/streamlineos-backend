/**
 * AutonomyActionsService — cross-tenant isolation
 *
 * Proves loadDeal scopes its query to the caller's org.
 * A deal owned by OWNER_ORG must be invisible to ATTACKER_ORG.
 */

import type { Db } from "../../db/drizzle.types";
import { AutonomyActionsService } from "./autonomy-actions.service";
import { DealsService } from "../deals/deals.service";

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

const DEAL = {
  id: 42,
  name: "Deal A",
  stage: "PROPOSAL",
  pipelineId: 1,
  updatedAt: new Date(),
};

function makeDb(rows: unknown[]) {
  const where = jest.fn();
  const limit = jest.fn().mockResolvedValue(rows);
  where.mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const selectChain = { from };
  const switchesWhere = jest.fn().mockResolvedValue([]);
  const switchesFrom = jest.fn().mockReturnValue({ where: switchesWhere });
  let selectCallCount = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount % 2 === 0) return { from: switchesFrom };
      return selectChain;
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
  } as unknown as Db;
  return { db, where };
}

function makeDealsService() {
  return {} as unknown as DealsService;
}

describe("AutonomyActionsService — cross-tenant isolation", () => {
  it("returns null for a deal in another org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new AutonomyActionsService(db, makeDealsService());

    const result = await svc.loadDeal(ATTACKER_ORG, 42);

    expect(result).toBeNull();
    expect(where).toHaveBeenCalled();
    const callArg = where.mock.calls[0]?.[0];
    expect(sqlValues(callArg)).toContain(ATTACKER_ORG);
  });

  it("returns the deal for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([DEAL]);
    const svc = new AutonomyActionsService(db, makeDealsService());

    const result = await svc.loadDeal(OWNER_ORG, 42);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(42);
  });
});
