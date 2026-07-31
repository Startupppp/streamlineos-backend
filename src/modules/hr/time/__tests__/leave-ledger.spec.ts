import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { LeaveLedgerService } from "../../leave-ledger.service";

const mockLimitFn = jest.fn().mockResolvedValue([]);
const mockWhereFn = jest.fn().mockReturnThis();
const mockGroupByFn = jest.fn().mockReturnThis();
const mockSelectFn = jest.fn().mockReturnThis();
const mockFromFn = jest.fn().mockReturnThis();
const mockInsertFn = jest.fn().mockReturnThis();
const mockValuesFn = jest.fn().mockResolvedValue(undefined);

const mockDb = {
  select: mockSelectFn,
  from: mockFromFn,
  where: mockWhereFn,
  groupBy: mockGroupByFn,
  limit: mockLimitFn,
  insert: mockInsertFn,
  values: mockValuesFn,
  query: {
    hrLeaveLedger: { findFirst: jest.fn() },
    hrPayrollInputPeriods: { findFirst: jest.fn() },
  },
};

describe("LeaveLedgerService — balanceFromLedger", () => {
  let service: LeaveLedgerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockWhereFn.mockReturnThis();
    mockGroupByFn.mockReturnThis();
    mockLimitFn.mockResolvedValue([]);
    mockInsertFn.mockReturnThis();
    mockValuesFn.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeaveLedgerService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(LeaveLedgerService);
  });

  it("balance is SUM(credits) - SUM(debits) and floored at 0", async () => {
    mockGroupByFn.mockResolvedValueOnce([
      { txnType: "accrual", total: "10.00" },
      { txnType: "consumption", total: "3.00" },
    ]);

    const balance = await service.balanceFromLedger("org1", "u1", 1);
    expect(balance).toBe(7);
  });

  it("balance is 0 when debits exceed credits (never negative)", async () => {
    mockGroupByFn.mockResolvedValueOnce([
      { txnType: "accrual", total: "2.00" },
      { txnType: "consumption", total: "10.00" },
    ]);

    const balance = await service.balanceFromLedger("org1", "u1", 1);
    expect(balance).toBe(0);
  });

  it("credits: accrual, adjustment, carry_forward, comp_off_earn, reversal all add to balance", async () => {
    mockGroupByFn.mockResolvedValueOnce([
      { txnType: "accrual", total: "5.00" },
      { txnType: "adjustment", total: "2.00" },
      { txnType: "carry_forward", total: "3.00" },
      { txnType: "comp_off_earn", total: "1.00" },
      { txnType: "reversal", total: "1.00" },
    ]);

    const balance = await service.balanceFromLedger("org1", "u1", 1);
    expect(balance).toBe(12);
  });

  it("debits: consumption subtracts from balance", async () => {
    mockGroupByFn.mockResolvedValueOnce([
      { txnType: "accrual", total: "20.00" },
      { txnType: "consumption", total: "8.00" },
      { txnType: "comp_off_use", total: "2.00" },
      { txnType: "encashment", total: "1.00" },
    ]);

    const balance = await service.balanceFromLedger("org1", "u1", 1);
    expect(balance).toBe(9);
  });

  it("returns 0 when there are no ledger rows", async () => {
    mockGroupByFn.mockResolvedValueOnce([]);

    const balance = await service.balanceFromLedger("org1", "u1", 1);
    expect(balance).toBe(0);
  });
});

describe("LeaveLedgerService — write", () => {
  let service: LeaveLedgerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockWhereFn.mockReturnThis();
    mockGroupByFn.mockReturnThis();
    mockLimitFn.mockResolvedValue([]);
    mockInsertFn.mockReturnThis();
    mockValuesFn.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeaveLedgerService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(LeaveLedgerService);
  });

  it("writes with the given txnType when period is not locked", async () => {
    mockDb.query.hrPayrollInputPeriods.findFirst.mockResolvedValueOnce(undefined);
    mockLimitFn.mockResolvedValueOnce([]);

    let capturedValues: Record<string, unknown> | null = null;
    mockValuesFn.mockImplementationOnce((v: Record<string, unknown>) => {
      capturedValues = v;
      return Promise.resolve(undefined);
    });

    await service.write({
      orgId: "org1",
      userId: "u1",
      leaveTypeId: 1,
      txnType: "accrual",
      days: 1.5,
      effectiveDate: "2026-07-01",
      source: "manual",
    });

    expect(capturedValues).not.toBeNull();
    expect(capturedValues!.txnType).toBe("accrual");
  });
});
