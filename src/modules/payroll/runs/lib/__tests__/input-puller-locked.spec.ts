import { pullFromLockedSnapshots, pullCalcFromLockedSnapshots } from "../input-puller";

describe("pullFromLockedSnapshots", () => {
  it("returns null when no locked period exists", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    const result = await pullFromLockedSnapshots(db as never, "org-1", "user-1", "2026-07");
    expect(result).toBeNull();
  });

  it("maps locked attendance+leave snapshots to payroll inputs", async () => {
    let selectCall = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ id: 9, status: "locked" }]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                userId: "user-1",
                section: "attendance",
                payload: {
                  payableDays: 26,
                  presentDays: 20,
                  absentDays: 2,
                  latePenaltyDays: 0.5,
                  holidayWorkDays: 1,
                  overtimeMinutes: 90,
                },
              },
              {
                userId: "user-1",
                section: "leave",
                payload: {
                  paidLeaveDays: 2,
                  unpaidLeaveDays: 1,
                  halfDayCount: 1,
                },
              },
              {
                userId: "user-1",
                section: "overtime",
                payload: { totalHours: 3 },
              },
            ]),
          }),
        };
      }),
    };

    const result = await pullFromLockedSnapshots(db as never, "org-1", "user-1", "2026-07");

    expect(result).not.toBeNull();
    expect(result?.fromLockedSnapshot).toBe(true);
    expect(result?.source).toBe("UPLOAD");
    expect(result?.scheduledDays).toBe("26");
    // present 20 + paid leave 2 + half 0.5 = 22.5
    expect(result?.paidDays).toBe("22.5");
    // absent 2 + unpaid 1 + late 0.5 + half 0.5 = 4.0
    expect(result?.lopDays).toBe("4.0");
    expect(result?.overtimeHours).toBe("3.00");
    expect(result?.holidayWorkDays).toBe("1");
  });
});

describe("pullCalcFromLockedSnapshots", () => {
  it("maps reimbursement and loan sections from locked period", async () => {
    let selectCall = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ id: 3 }]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                userId: "user-1",
                section: "reimbursement",
                payload: {
                  items: [
                    { id: 11, amount: "1500.00", category: "TRAVEL", source: "reimbursement" },
                    { id: 12, amount: "200", category: "benefits_claim", source: "benefits_claim" },
                  ],
                },
              },
              {
                userId: "user-1",
                section: "deduction",
                payload: {
                  activeLoans: [
                    {
                      id: 7,
                      amount: "50000",
                      emiAmount: "5000",
                      paidEmis: 2,
                      totalEmis: 10,
                    },
                  ],
                },
              },
              {
                userId: "user-1",
                section: "overtime",
                payload: { totalHours: 4.5 },
              },
            ]),
          }),
        };
      }),
    };

    const result = await pullCalcFromLockedSnapshots(db as never, "org-1", "user-1", "2026-07");
    expect(result?.fromLockedSnapshot).toBe(true);
    expect(result?.approvedReimbursements).toHaveLength(2);
    expect(result?.consumedReimbursementIds).toEqual([11]);
    expect(result?.activeLoans).toEqual([
      expect.objectContaining({ id: 7, emiAmount: "5000", paidEmis: 2 }),
    ]);
    expect(result?.overtimeHours).toBe("4.50");
  });
});

