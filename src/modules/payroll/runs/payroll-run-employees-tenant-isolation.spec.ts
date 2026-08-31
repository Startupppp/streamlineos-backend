import type { Db } from "../../../db/drizzle.module";
import { PayrollRunEmployeesService } from "./payroll-run-employees.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { ListRunEmployeesQuery } from "./dto/runs.schemas";
import type { DataScope } from "../../access/access.types";

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

describe("PayrollRunEmployeesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const RUN_ID = 3;
  const EMP_ID = 17;
  const ACTOR = "user-actor";

  function makeSelectDb(rows: unknown[]): { db: Db; where: jest.Mock } {
    const where = jest.fn();
    const limit = jest.fn().mockResolvedValue(rows);
    const orderBy = jest.fn().mockReturnValue({ limit });
    where.mockReturnValue({ limit, orderBy });

    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ where, innerJoin });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    return { db, where };
  }

  const audit = { log: jest.fn() } as unknown as AuditService;
  const scope: DataScope = { kind: "all" } as DataScope;
  const listQuery: ListRunEmployeesQuery = { limit: 25 } as ListRunEmployeesQuery;

  it("listRunEmployees scopes run check to the attacker org — cross-tenant isolation", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new PayrollRunEmployeesService(db, audit);

    const result = await svc.listRunEmployees(ATTACKER_ORG, RUN_ID, listQuery, scope, ACTOR);

    expect(result).toBeNull();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("getRunEmployee returns null when run belongs to a different org — cross-tenant isolation", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new PayrollRunEmployeesService(db, audit);

    const result = await svc.getRunEmployee(ATTACKER_ORG, RUN_ID, EMP_ID);

    expect(result).toBeNull();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("setEmployeeHold returns false when run is from a different org — cross-tenant isolation", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new PayrollRunEmployeesService(db, audit);

    const result = await svc.setEmployeeHold(ATTACKER_ORG, RUN_ID, EMP_ID, true, null, ACTOR);

    expect(result).toEqual({ ok: false });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });
});
