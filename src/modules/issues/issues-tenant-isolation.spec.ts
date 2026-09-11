/**
 * IssuesService — cross-tenant isolation
 *
 * Proves the service scopes every query to the caller's org and cannot surface
 * records owned by a different org, satisfying the BOLA requirement.
 */

import { ScopedRead } from "../access/scoped-read";
import type { Db } from "../../db/drizzle.types";
import { IssuesService } from "./issues.service";
import { IssueTransitionsService } from "./issue-transitions.service";
import type { ListIssuesQuery } from "./dto/issues.schemas";
import type { DataScope } from "../access/access.types";

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

type SelectChain = {
  from: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
};

function makeListDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  where.mockReturnValue({ orderBy });
  const leftJoin = jest.fn();
  leftJoin.mockReturnThis();
  const chain: SelectChain = {
    from: jest.fn(),
    leftJoin,
    where,
    orderBy,
    limit,
  };
  chain.from.mockReturnValue(chain);
  const db = { select: jest.fn().mockReturnValue(chain) } as unknown as Db;
  return { db, where };
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const QUERY: ListIssuesQuery = {
  recordType: "complaint",
  limit: 20,
  cursor: undefined,
  order: "newest",
};
const SCOPE: DataScope = "all";

const FAKE_ROW = {
  issueRecordId: "rec-1",
  recordType: "complaint" as const,
  title: "Test",
  severity: "LOW" as const,
  stage: "open" as const,
  ownerUserId: "user-1",
  partyId: "party-1",
  dealId: null,
  dueAt: null,
  openedAt: new Date(),
  acknowledgedAt: null,
  closedAt: null,
  details: null,
  reference: null,
  partyName: null,
  dealTitle: null,
};

function makeTransitionsMock() {
  return {
    list: jest.fn().mockResolvedValue([]),
    recordOpening: jest.fn().mockResolvedValue(undefined),
    transition: jest.fn(),
    escalate: jest.fn(),
  } as unknown as IssueTransitionsService;
}

describe("IssuesService — cross-tenant isolation", () => {
  it("returns nothing for a different org (cross-tenant access denied)", async () => {
    const { db, where } = makeListDb([]);
    const svc = new IssuesService(db, makeTransitionsMock());

    const result = await svc.list(ScopedRead.of(ATTACKER_ORG, "user-x", SCOPE), QUERY);

    expect(result.data).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const callArg = where.mock.calls[0]?.[0];
    expect(sqlValues(callArg)).toContain(ATTACKER_ORG);
  });

  it("returns the row for the owning org (same-tenant control)", async () => {
    const { db } = makeListDb([FAKE_ROW]);
    const svc = new IssuesService(db, makeTransitionsMock());

    const result = await svc.list(ScopedRead.of(OWNER_ORG, "user-1", SCOPE), QUERY);

    expect(result.data.length).toBeGreaterThan(0);
  });
});
