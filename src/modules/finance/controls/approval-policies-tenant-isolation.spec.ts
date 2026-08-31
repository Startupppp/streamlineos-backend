import type { Db } from "../../../db/drizzle.module";
import { ApprovalPoliciesService } from "./approval-policies.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("ApprovalPoliciesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeService(rows: unknown[]): { svc: ApprovalPoliciesService; where: jest.Mock } {
    const where = jest.fn();
    const dataChain = { limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue(rows) }) };
    const countChain = Promise.resolve([{ count: rows.length }]);
    let callCount = 0;
    where.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? dataChain : countChain;
    });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const db = { select } as unknown as Db;
    const audit = { log: jest.fn() } as any;
    const svc = new ApprovalPoliciesService(db, audit);
    return { svc, where };
  }

  it("scopes list to the requesting org (tenant isolation)", async () => {
    const { svc, where } = makeService([]);

    await svc.list(ATTACKER_ORG, 1, 20);

    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns items for the owning org (same-tenant control)", async () => {
    const { svc } = makeService([{ id: 1, orgId: OWNER_ORG }]);

    const result = await svc.list(OWNER_ORG, 1, 20);

    expect(result.items).toHaveLength(1);
  });
});
