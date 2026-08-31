import type { Db } from "../../../db/drizzle.module";
import { PayrollApproverResolverService } from "./payroll-approver-resolver.service";

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

describe("PayrollApproverResolverService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const PERMISSION_KEY = "payroll:runs:approve";

  function makeDb(rows: unknown[]): { db: Db; whereCaptures: jest.Mock[] } {
    const whereCaptures: jest.Mock[] = [];

    function makeBuilder(result: unknown[]) {
      const where = jest.fn().mockResolvedValue(result);
      whereCaptures.push(where);
      const innerJoin = jest.fn();
      const from = jest.fn();
      const builder = { from, innerJoin, where };
      from.mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }) }), where });
      innerJoin.mockReturnValue(builder);
      return { select: jest.fn().mockReturnValue(builder), where };
    }

    let callIndex = 0;
    const select = jest.fn().mockImplementation(() => {
      const result = callIndex < rows.length ? [rows[callIndex]] : [];
      callIndex++;
      const where = jest.fn().mockResolvedValue(result);
      whereCaptures.push(where);
      return {
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where,
            }),
            where,
          }),
          where,
        }),
      };
    });

    const db = { select } as unknown as Db;
    return { db, whereCaptures };
  }

  it("returns empty list when no approvers exist in the attacker org — cross-tenant isolation", async () => {
    const { db, whereCaptures } = makeDb([]);
    const svc = new PayrollApproverResolverService(db);

    const result = await svc.resolveApprovers(ATTACKER_ORG, PERMISSION_KEY);

    expect(result).toHaveLength(0);
    const allValues = whereCaptures.flatMap((w) => sqlValues(w.mock.calls[0]?.[0]));
    expect(allValues).toContain(ATTACKER_ORG);
  });

  it("resolves approver user IDs scoped to the requesting org only — org-predicate present", async () => {
    const { db, whereCaptures } = makeDb([{ userId: "user-approver" }]);
    const svc = new PayrollApproverResolverService(db);

    await svc.resolveApprovers(ATTACKER_ORG, PERMISSION_KEY);

    const allValues = whereCaptures.flatMap((w) => sqlValues(w.mock.calls[0]?.[0]));
    expect(allValues).toContain(ATTACKER_ORG);
  });
});
