import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { ListRunEmployeesQuery } from "./dto/runs.schemas";
import { ScopedRead } from "../../access/scoped-read";
import { encodeCursor } from "../../../common/pagination/cursor";
import { PayrollRunEmployeesService } from "./payroll-run-employees.service";

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
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ORG = "org-alpha";
const ACTOR = "user-actor";
const RUN_ID = 7;
const CURSOR_NAME = "ZZ-CURSOR-BOUNDARY";

function row(id: number, userName: string) {
  return {
    id,
    userId: `user-${id}`,
    workerType: "EMPLOYEE",
    currency: "INR",
    gross: "100000.00",
    totalDeductions: "0.00",
    net: "100000.00",
    status: "PENDING",
    holdReason: null,
    userName,
    userEmail: `user-${id}@alpha.test`,
  };
}

function makeDb(runRows: unknown[], pageRows: unknown[], total: number) {
  const runLimit = jest.fn().mockResolvedValue(runRows);
  const runWhere = jest.fn().mockReturnValue({ limit: runLimit });
  const runFrom = jest.fn().mockReturnValue({ where: runWhere });

  const pageLimit = jest.fn().mockResolvedValue(pageRows);
  const pageOrderBy = jest.fn().mockReturnValue({ limit: pageLimit });
  const pageWhere = jest.fn().mockReturnValue({ orderBy: pageOrderBy });
  const pageJoin = jest.fn().mockReturnValue({ where: pageWhere });
  const pageFrom = jest.fn().mockReturnValue({ innerJoin: pageJoin });

  const countWhere = jest.fn().mockResolvedValue([{ value: total }]);
  const countJoin = jest.fn().mockReturnValue({ where: countWhere });
  const countFrom = jest.fn().mockReturnValue({ innerJoin: countJoin });

  const select = jest
    .fn()
    .mockReturnValueOnce({ from: runFrom })
    .mockReturnValueOnce({ from: pageFrom })
    .mockReturnValueOnce({ from: countFrom });

  return {
    db: { select } as unknown as Db,
    pageWhere,
    countWhere,
  };
}

const audit = { log: jest.fn() } as unknown as AuditService;

function query(overrides: Partial<ListRunEmployeesQuery> = {}): ListRunEmployeesQuery {
  return { limit: 25, ...overrides } as ListRunEmployeesQuery;
}

describe("the run-employees roster reports how many employees are in the cycle", () => {
  it("reports the filter-wide total rather than the number of rows on the page", async () => {
    const { db } = makeDb([{ id: RUN_ID }], [row(1, "Asha"), row(2, "Bo")], 212);
    const service = new PayrollRunEmployeesService(db, audit);

    const result = await service.listRunEmployees(
      ScopedRead.of(ORG, ACTOR, "all"),
      RUN_ID,
      query(),
    );

    expect(result?.data).toHaveLength(2);
    expect(result?.pagination.total).toBe(212);
  });

  it("reports a measured zero, which is what lets the board tell an empty cycle from an unmeasured one", async () => {
    const { db } = makeDb([{ id: RUN_ID }], [], 0);
    const service = new PayrollRunEmployeesService(db, audit);

    const result = await service.listRunEmployees(
      ScopedRead.of(ORG, ACTOR, "all"),
      RUN_ID,
      query(),
    );

    expect(result?.pagination.total).toBe(0);
    expect(result?.data).toEqual([]);
  });

  it("holds the total steady on a later page, where a page-derived count would shrink", async () => {
    const cursor = encodeCursor({ sortValue: CURSOR_NAME, id: "40" });
    const { db } = makeDb([{ id: RUN_ID }], [row(41, "Yusuf")], 212);
    const service = new PayrollRunEmployeesService(db, audit);

    const result = await service.listRunEmployees(
      ScopedRead.of(ORG, ACTOR, "all"),
      RUN_ID,
      query({ cursor }),
    );

    expect(result?.pagination.hasMore).toBe(false);
    expect(result?.pagination.total).toBe(212);
  });
});

describe("the count is scoped, and it answers how many match rather than how many are left", () => {
  it("installs the tenant on the count, so a total can never be read across organisations", async () => {
    const { db, countWhere } = makeDb([{ id: RUN_ID }], [row(1, "Asha")], 5);
    const service = new PayrollRunEmployeesService(db, audit);

    await service.listRunEmployees(ScopedRead.of(ORG, ACTOR, "all"), RUN_ID, query());

    expect(countWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(ORG);
  });

  it("excludes the cursor position from the count while the page keeps it", async () => {
    const cursor = encodeCursor({ sortValue: CURSOR_NAME, id: "40" });
    const { db, pageWhere, countWhere } = makeDb([{ id: RUN_ID }], [row(41, "Yusuf")], 212);
    const service = new PayrollRunEmployeesService(db, audit);

    await service.listRunEmployees(ScopedRead.of(ORG, ACTOR, "all"), RUN_ID, query({ cursor }));

    expect(sqlValues(pageWhere.mock.calls[0]?.[0])).toContain(CURSOR_NAME);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).not.toContain(CURSOR_NAME);
  });

  it("applies the caller's own filters to the count, so the denominator matches the list", async () => {
    const { db, countWhere } = makeDb([{ id: RUN_ID }], [row(1, "Asha")], 3);
    const service = new PayrollRunEmployeesService(db, audit);

    await service.listRunEmployees(
      ScopedRead.of(ORG, ACTOR, "all"),
      RUN_ID,
      query({ status: "PENDING" } as Partial<ListRunEmployeesQuery>),
    );

    expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain("PENDING");
  });

  it("never counts before the run has been tenant-checked", async () => {
    const { db, countWhere } = makeDb([], [], 99);
    const service = new PayrollRunEmployeesService(db, audit);

    const result = await service.listRunEmployees(
      ScopedRead.of("org-attacker", ACTOR, "all"),
      RUN_ID,
      query(),
    );

    expect(result).toBeNull();
    expect(countWhere).not.toHaveBeenCalled();
  });

  it("counts nothing for a denied scope rather than reporting the organisation's figure", async () => {
    const { db, countWhere } = makeDb([{ id: RUN_ID }], [], 0);
    const service = new PayrollRunEmployeesService(db, audit);

    const result = await service.listRunEmployees(
      ScopedRead.of(ORG, ACTOR, "none"),
      RUN_ID,
      query(),
    );

    expect(result?.pagination.total).toBe(0);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).not.toContain(ORG);
  });
});
