import { GeneralLedgerService } from "./general-ledger.service";
import { decodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";

function makeGlRow(lineId: number, entryDate: string, debit = "100.00", credit = "0.00") {
  return {
    lineId,
    entryId: lineId,
    entryNumber: `JE-${lineId}`,
    entryDate,
    description: null as string | null,
    entryDescription: null as string | null,
    accountId: 1,
    accountCode: "1100",
    accountName: "Bank",
    debit,
    credit,
    sourceType: "manual",
    sourceId: null as string | null,
    clientId: null as number | null,
    vendorId: null as number | null,
    projectId: null as number | null,
    departmentId: null as string | null,
  };
}

function buildService(pageRows: ReturnType<typeof makeGlRow>[]): GeneralLedgerService {
  const aggregateRow = [{ totalDebit: "0", totalCredit: "0" }];

  let selectCall = 0;
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    then: undefined as unknown,
  };
  const self = () => builder;
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.innerJoin as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);

  (builder.limit as jest.Mock).mockImplementation(() => {
    selectCall++;
    if (selectCall === 3) return Promise.resolve(pageRows);
    return Promise.resolve(pageRows);
  });

  builder["then"] = (resolve: (v: unknown) => void) => {
    selectCall++;
    return resolve(aggregateRow);
  };

  let outerCall = 0;
  const db = {
    select: jest.fn(() => {
      outerCall++;
      if (outerCall === 1) return { ...builder, then: (r: (v: unknown[]) => void) => r(aggregateRow) };
      if (outerCall === 4) return { ...builder, then: (r: (v: unknown[]) => void) => r(aggregateRow) };
      return builder;
    }),
  } as unknown as Db;

  return new GeneralLedgerService(db);
}

const BASE_QUERY = {
  from: "2024-01-01",
  to: "2024-01-31",
  limit: 50,
  format: "json" as const,
};

describe("GeneralLedgerService — keyset cursor pagination", () => {
  it("returns items with no nextCursor when rows <= limit", async () => {
    const rows = [makeGlRow(1, "2024-01-10"), makeGlRow(2, "2024-01-15")];
    const svc = buildService(rows);

    const result = await svc.getGeneralLedger("org-1", { ...BASE_QUERY, limit: 50 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("sets nextCursor when sentinel row present", async () => {
    const limit = 2;
    const rows = [makeGlRow(1, "2024-01-10"), makeGlRow(2, "2024-01-15"), makeGlRow(3, "2024-01-20")];
    const svc = buildService(rows);

    const result = await svc.getGeneralLedger("org-1", { ...BASE_QUERY, limit });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it("tie-breaking: cursor encodes both entryDate and lineId so same-date rows page correctly", async () => {
    const limit = 2;
    const rows = [
      makeGlRow(10, "2024-01-15"),
      makeGlRow(20, "2024-01-15"),
      makeGlRow(30, "2024-01-15"),
    ];
    const svc = buildService(rows);

    const result = await svc.getGeneralLedger("org-1", { ...BASE_QUERY, limit });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();

    const pos = decodeCursor(result.nextCursor ?? undefined);
    expect(pos).not.toBeNull();
    expect(pos?.sortValue).toBe("2024-01-15");
    expect(pos?.id).toBe("20");
  });

  it("running balance starts at openingBalance and accumulates debit minus credit", async () => {
    const rows = [makeGlRow(1, "2024-01-10", "100.00", "0.00"), makeGlRow(2, "2024-01-15", "0.00", "30.00")];
    const svc = buildService(rows);

    const result = await svc.getGeneralLedger("org-1", { ...BASE_QUERY, limit: 50 });

    expect(result.items[0]?.runningBalance).toBe(100);
    expect(result.items[1]?.runningBalance).toBe(70);
  });
});
