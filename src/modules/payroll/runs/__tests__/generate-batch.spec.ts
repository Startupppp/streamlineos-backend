import {
  buildPulledInputsFromSections,
  buildCalcPullsFromSections,
  buildLiveAttendanceInputs,
  type SectionMap,
} from "../lib/input-puller";
import { GeneratePipelineService, type RunBatchData } from "../generate-pipeline.service";
import { DEFAULT_PAYROLL_TOGGLES } from "../../payroll.types";
import type { PayrollToggles } from "../../payroll.types";

function sections(entries: Record<string, Record<string, unknown>>): SectionMap {
  return new Map(Object.entries(entries));
}

function emptyBatch(overrides: Partial<RunBatchData> = {}): RunBatchData {
  return {
    lockedPeriodId: null,
    lockedSectionsByUser: new Map(),
    runInputsByUser: new Map(),
    liveAttendanceByUser: new Map(),
    componentsByProfileId: new Map(),
    bonusesByUser: new Map(),
    incentivesByUser: new Map(),
    reimbursementsByUser: new Map(),
    loansByUser: new Map(),
    taxDeclarationByUser: new Map(),
    ...overrides,
  };
}

const toggles: PayrollToggles = {
  ...DEFAULT_PAYROLL_TOGGLES,
  lopFromAttendance: true,
  bonuses: true,
  incentives: true,
  reimbursements: true,
  loans: true,
  tds: true,
};

describe("buildPulledInputsFromSections", () => {
  it("returns null for a user with no snapshot sections", () => {
    expect(buildPulledInputsFromSections("u1", "2026-07", undefined)).toBeNull();
    expect(buildPulledInputsFromSections("u1", "2026-07", new Map())).toBeNull();
  });

  it("derives paid/LOP days from attendance and leave sections", () => {
    const result = buildPulledInputsFromSections(
      "u1",
      "2026-07",
      sections({
        attendance: { payableDays: 22, presentDays: 18, absentDays: 2, overtimeMinutes: 90 },
        leave: { paidLeaveDays: 1, unpaidLeaveDays: 1, halfDayCount: 2 },
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.scheduledDays).toBe("22");
    expect(result?.paidDays).toBe("20.0");
    expect(result?.lopDays).toBe("4.0");
    expect(result?.halfDays).toBe("2");
    expect(result?.overtimeHours).toBe("1.50");
    expect(result?.source).toBe("UPLOAD");
    expect(result?.fromLockedSnapshot).toBe(true);
  });
});

describe("buildCalcPullsFromSections", () => {
  it("returns null without sections", () => {
    expect(buildCalcPullsFromSections(undefined)).toBeNull();
  });

  it("parses reimbursements, excludes benefits claims from consumption, and maps loans", () => {
    const result = buildCalcPullsFromSections(
      sections({
        reimbursement: {
          items: [
            { id: 1, amount: 1200.5, category: "TRAVEL" },
            { id: 2, amount: "300", category: "MEDICAL", source: "benefits_claim" },
          ],
        },
        deduction: {
          activeLoans: [{ id: 9, emiAmount: "1000", amount: "12000", paidEmis: 3, totalEmis: 12 }],
        },
        overtime: { totalHours: 5 },
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.approvedReimbursements).toEqual([
      { amount: "1200.50", category: "TRAVEL" },
      { amount: "300", category: "MEDICAL" },
    ]);
    expect(result?.consumedReimbursementIds).toEqual([1]);
    expect(result?.activeLoans).toEqual([
      { id: 9, emiAmount: "1000", amount: "12000", paidEmis: 3, totalEmis: 12, adjustment: null },
    ]);
    expect(result?.overtimeHours).toBe("5.00");
  });
});

describe("buildLiveAttendanceInputs", () => {
  it("returns null when the user has no attendance records", () => {
    expect(buildLiveAttendanceInputs("u1", "2026-07", [], [{ lopDays: "2" }])).toBeNull();
  });

  it("counts paid, LOP, half-day, and holiday work statuses plus leave LOP", () => {
    const result = buildLiveAttendanceInputs(
      "u1",
      "2026-07",
      [
        { status: "PRESENT" },
        { status: "WFH" },
        { status: "HALFDAY" },
        { status: "ABSENT" },
        { status: "HOLIDAY_WORK" },
      ],
      [{ lopDays: "1.5" }],
    );

    expect(result?.paidDays).toBe("3.5");
    expect(result?.lopDays).toBe("3.0");
    expect(result?.halfDays).toBe("1");
    expect(result?.holidayWorkDays).toBe("1");
    expect(result?.source).toBe("ATTENDANCE");
  });
});

describe("GeneratePipelineService batch builders", () => {
  const service = new GeneratePipelineService({} as never);

  it("prefers an existing run input row over snapshots and live pulls", () => {
    const batch = emptyBatch({
      runInputsByUser: new Map([
        [
          "u1",
          {
            source: "MANUAL",
            scheduledDays: "30",
            paidDays: "28",
            lopDays: "2",
            halfDays: "0",
            overtimeHours: "0",
            shiftAllowanceUnits: "0",
            holidayWorkDays: "0",
            billableHours: "0",
            isOverride: true,
            overrideReason: "Adjusted by admin",
          } as never,
        ],
      ]),
      lockedSectionsByUser: new Map([
        ["u1", sections({ attendance: { presentDays: 10 } })],
      ]),
    });

    const inputs = service.buildInputsFromBatch("u1", "2026-07", toggles, batch);
    expect(inputs.paidDays).toBe("28");
    expect(inputs.isOverride).toBe(true);
    expect(inputs.overrideReason).toBe("Adjusted by admin");
  });

  it("falls back to locked snapshot, then live attendance, then full-month manual", () => {
    const lockedBatch = emptyBatch({
      lockedSectionsByUser: new Map([
        ["u1", sections({ attendance: { payableDays: 20, presentDays: 20 } })],
      ]),
    });
    expect(service.buildInputsFromBatch("u1", "2026-07", toggles, lockedBatch).overrideReason).toBe(
      "Locked payroll input period snapshot",
    );

    const liveBatch = emptyBatch({
      liveAttendanceByUser: new Map([
        [
          "u1",
          buildLiveAttendanceInputs("u1", "2026-07", [{ status: "PRESENT" }], []),
        ],
      ]),
    });
    const liveInputs = service.buildInputsFromBatch("u1", "2026-07", toggles, liveBatch);
    expect(liveInputs.source).toBe("ATTENDANCE");
    expect(liveInputs.paidDays).toBe("1");

    const manualInputs = service.buildInputsFromBatch("u1", "2026-07", toggles, emptyBatch());
    expect(manualInputs.source).toBe("MANUAL");
    expect(manualInputs.scheduledDays).toBe("31");
    expect(manualInputs.paidDays).toBe("31");
  });

  it("builds calc pulls from per-user grouped rows and respects toggles", () => {
    const batch = emptyBatch({
      bonusesByUser: new Map([
        ["u1", [{ id: 4, userId: "u1", amount: "5000", type: "PERFORMANCE", taxable: true }]],
      ]),
      incentivesByUser: new Map([
        ["u1", [{ id: 6, salesRepId: "u1", approvedAmount: null, calculatedAmount: "750" }]],
      ]),
      reimbursementsByUser: new Map([
        ["u1", [{ id: 11, userId: "u1", amount: "900", category: "TRAVEL" }]],
      ]),
      loansByUser: new Map([
        ["u1", [{ id: 3, emiAmount: "1000", amount: "6000", paidEmis: 1, totalEmis: 6, adjustment: null }]],
      ]),
    });

    const pulls = service.buildCalcInputsFromBatch("u1", toggles, batch);
    expect(pulls.approvedBonuses).toEqual([{ amount: "5000", type: "PERFORMANCE", taxable: true }]);
    expect(pulls.consumedBonusIds).toEqual([4]);
    expect(pulls.approvedIncentives).toEqual([{ amount: "750" }]);
    expect(pulls.consumedIncentiveIds).toEqual([6]);
    expect(pulls.approvedReimbursements).toEqual([{ amount: "900", category: "TRAVEL" }]);
    expect(pulls.consumedReimbursementIds).toEqual([11]);
    expect(pulls.activeLoans).toHaveLength(1);

    const disabled = service.buildCalcInputsFromBatch(
      "u1",
      { ...toggles, bonuses: false, incentives: false, reimbursements: false, loans: false },
      batch,
    );
    expect(disabled.approvedBonuses).toEqual([]);
    expect(disabled.approvedIncentives).toEqual([]);
    expect(disabled.approvedReimbursements).toEqual([]);
    expect(disabled.activeLoans).toEqual([]);
  });

  it("prefers locked snapshot reimbursements and loans over live rows", () => {
    const batch = emptyBatch({
      lockedSectionsByUser: new Map([
        [
          "u1",
          sections({
            reimbursement: { items: [{ id: 21, amount: 400, category: "FOOD" }] },
            deduction: { activeLoans: [] },
          }),
        ],
      ]),
      reimbursementsByUser: new Map([
        ["u1", [{ id: 99, userId: "u1", amount: "111", category: "OTHER" }]],
      ]),
    });

    const pulls = service.buildCalcInputsFromBatch("u1", toggles, batch);
    expect(pulls.consumedReimbursementIds).toEqual([21]);
    expect(pulls.approvedReimbursements).toEqual([{ amount: "400.00", category: "FOOD" }]);
  });
});
