/**
 * AutonomyReversalService — cross-tenant isolation
 *
 * Proves reverseDecision scopes to the caller's org; a foreign decisionId
 * returns NotFoundException (404), never leaking cross-tenant existence.
 */

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { AutonomyReversalService } from "./autonomy-reversal.service";
import { DealsService } from "../deals/deals.service";
import type { ReverseDecisionInput } from "./dto/autonomy-review.schemas";

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

const INPUT: ReverseDecisionInput = { reason: "testing", consented: true };

function makeDb(decisionRow: unknown) {
  const limitReturnsDecision = jest.fn().mockResolvedValue(decisionRow ? [decisionRow] : []);
  const whereForSelect = jest.fn().mockReturnValue({ limit: limitReturnsDecision });
  const fromForSelect = jest.fn().mockReturnValue({ where: whereForSelect });
  const db = {
    select: jest.fn().mockReturnValue({ from: fromForSelect }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
  } as unknown as Db;
  return { db, whereForSelect };
}

function makeDealsService() {
  return {} as unknown as DealsService;
}

describe("AutonomyReversalService — cross-tenant isolation", () => {
  it("throws NotFoundException for a decisionId belonging to another org (cross-tenant denied)", async () => {
    const { db, whereForSelect } = makeDb(null);
    const svc = new AutonomyReversalService(db, makeDealsService());

    await expect(svc.reverseDecision(ATTACKER_ORG, "user-x", "dec-999", INPUT)).rejects.toThrow(
      NotFoundException,
    );

    const callArg = whereForSelect.mock.calls[0]?.[0];
    expect(sqlValues(callArg)).toContain(ATTACKER_ORG);
  });

  it("raises NotFoundException when the owning org queries a non-existent decision (control: org_id correct, id wrong)", async () => {
    const { db } = makeDb(null);
    const svc = new AutonomyReversalService(db, makeDealsService());

    await expect(svc.reverseDecision(OWNER_ORG, "user-1", "dec-missing", INPUT)).rejects.toThrow(
      NotFoundException,
    );
  });
});
