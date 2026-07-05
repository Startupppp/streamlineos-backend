import { calcPayroll } from "../calculation-engine";
import type { CalcEngineInput, ResolvedComponent } from "../calculation-engine";
import { detectExceptions } from "../exception-engine";
import type { CalculationSnapshot } from "../../../payroll.types";
import { DEFAULT_PAYROLL_TOGGLES } from "../../../payroll.types";

const baseConfig = {
  rounding: { mode: "NEAREST" as const, precision: 2 as const },
  components: [],
  approvalChain: [],
  payslipLayout: "CLASSIC" as const,
  calendar: { attendanceCutoffDay: 26, reimbursementCutoffDay: 26, declarationCutoffDay: 20, previewDay: 28, approvalDeadlineDay: 30, publishOffsetDays: 1 },
  statutory: {
    pfEmployeePercent: "12.00", pfEmployerPercent: "13.00",
    pfWageCeiling: "15000.00",
    esiEmployeePercent: "0.75", esiEmployerPercent: "3.25",
    esiWageCeiling: "21000.00",
    professionalTaxMonthly: "200.00",
    tdsMode: "NONE" as const, tdsFlatPercent: null,
  },
  overtime: { multiplier: "1.5", basis: "BASIC" as const },
  varianceThresholdPercent: 20,
};

const basicComponent: ResolvedComponent = {
  id: 1, code: "BASIC", name: "Basic", type: "EARNING" as const,
  calcMethod: "PERCENT_OF_BASIC" as const,
  amount: null, percent: "40", formula: null,
  taxable: true, showOnPayslip: true, includeInCtc: true,
  isStatutory: false, sortOrder: 1,
};

const hraComponent: ResolvedComponent = {
  id: 2, code: "HRA", name: "HRA", type: "EARNING" as const,
  calcMethod: "PERCENT_OF_BASIC" as const,
  amount: null, percent: "20", formula: null,
  taxable: false, showOnPayslip: true, includeInCtc: true,
  isStatutory: false, sortOrder: 2,
};

const baseInput: CalcEngineInput = {
  policyVersionId: 1,
  month: "2025-07",
  annualCtcDecimal: "1200000.00",
  workerType: "EMPLOYEE",
  currency: "INR", payoutCurrency: null, fxRate: null,
  taxRegime: "NEW",
  components: [basicComponent, hraComponent],
  toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, esi: false, professionalTax: false },
  config: baseConfig,
  inputs: { scheduledDays: "30", paidDays: "30", lopDays: "0", overtimeHours: "0" },
  pulls: { approvedBonuses: [], approvedIncentives: [], approvedReimbursements: [], activeLoans: [] },
  previousSnapshot: null,
};

describe("payroll engine extended", () => {
  describe("(a) approved bonus", () => {
    it("appears as EARNING line with correct amount", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...baseInput.toggles, bonuses: true },
        pulls: {
          ...baseInput.pulls,
          approvedBonuses: [{ amount: "10000.00", type: "PERFORMANCE", taxable: true }],
        },
      };
      const snap = calcPayroll(input);
      const bonusLine = snap.lines.find(l => l.code.startsWith("BONUS_"));
      expect(bonusLine).toBeDefined();
      expect(bonusLine!.category).toBe("EARNING");
      expect(parseFloat(bonusLine!.amount)).toBeCloseTo(10000, 0);
    });
  });

  describe("(b) approved incentive", () => {
    it("appears as EARNING line", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...baseInput.toggles, incentives: true },
        pulls: {
          ...baseInput.pulls,
          approvedIncentives: [{ amount: "15000.00" }],
        },
      };
      const snap = calcPayroll(input);
      const incLine = snap.lines.find(l => l.code.startsWith("INCENTIVE_"));
      expect(incLine).toBeDefined();
      expect(incLine!.category).toBe("EARNING");
      expect(parseFloat(incLine!.amount)).toBeCloseTo(15000, 0);
    });

    it("feeds incentive_amount into formula scope", () => {
      const formulaComp: ResolvedComponent = {
        id: 10, code: "INC_BONUS", name: "Incentive Bonus",
        type: "EARNING" as const,
        calcMethod: "FORMULA" as const,
        amount: null, percent: null, formula: "incentive_amount * 0.1",
        taxable: true, showOnPayslip: true, includeInCtc: false,
        isStatutory: false, sortOrder: 5,
      };
      const input: CalcEngineInput = {
        ...baseInput,
        components: [basicComponent, formulaComp],
        pulls: {
          ...baseInput.pulls,
          approvedIncentives: [{ amount: "20000.00" }],
        },
      };
      const snap = calcPayroll(input);
      const line = snap.lines.find(l => l.code === "INC_BONUS");
      expect(line).toBeDefined();
      expect(parseFloat(line!.amount)).toBeCloseTo(2000, 0);
    });
  });

  describe("(c) overtime", () => {
    it("computes (basic / scheduledDays / 8) * overtimeHours * multiplier", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...baseInput.toggles, overtime: true },
        inputs: { ...baseInput.inputs, overtimeHours: "8" },
      };
      const snap = calcPayroll(input);
      const otLine = snap.lines.find(l => l.code === "OVERTIME");
      expect(otLine).toBeDefined();

      const monthlyCtc = 1200000 / 12;
      const basic = monthlyCtc * 0.4;
      const scheduledDays = 30;
      const expectedOt = (basic / scheduledDays / 8) * 8 * 1.5;
      expect(parseFloat(otLine!.amount)).toBeCloseTo(expectedOt, 0);
    });
  });

  describe("(d) statutory toggles", () => {
    it("ESI deduction appears when toggle on and gross within ceiling", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        annualCtcDecimal: "240000.00",
        toggles: { ...baseInput.toggles, esi: true },
        components: [basicComponent, hraComponent],
      };
      const snap = calcPayroll(input);
      const esiLine = snap.lines.find(l => l.code === "ESI_EMPLOYEE");
      expect(esiLine).toBeDefined();
      expect(esiLine!.category).toBe("DEDUCTION");
    });

    it("professional tax deduction appears when toggle on", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...baseInput.toggles, professionalTax: true },
      };
      const snap = calcPayroll(input);
      const ptLine = snap.lines.find(l => l.code === "PROFESSIONAL_TAX");
      expect(ptLine).toBeDefined();
      expect(ptLine!.category).toBe("DEDUCTION");
    });
  });

  describe("(e) TIMESHEET_BASED", () => {
    it("computes hourlyRate * billableHours", () => {
      const tsComp: ResolvedComponent = {
        id: 20, code: "BASIC", name: "Basic",
        type: "EARNING" as const,
        calcMethod: "TIMESHEET_BASED" as const,
        amount: "500.00",
        percent: null, formula: null,
        taxable: true, showOnPayslip: true, includeInCtc: true,
        isStatutory: false, sortOrder: 1,
      };
      const input: CalcEngineInput = {
        ...baseInput,
        components: [tsComp],
        inputs: { ...baseInput.inputs, billableHours: "160" },
      };
      const snap = calcPayroll(input);
      const basicLine = snap.lines.find(l => l.code === "BASIC");
      expect(basicLine).toBeDefined();
      expect(parseFloat(basicLine!.amount)).toBeCloseTo(500 * 160, 0);
    });
  });

  describe("(f) non-FIXED deductions", () => {
    it("PERCENT_OF_BASIC deduction computes correctly and reduces net", () => {
      const deductComp: ResolvedComponent = {
        id: 30, code: "ADVANCE_RECOVERY", name: "Advance Recovery",
        type: "DEDUCTION" as const,
        calcMethod: "PERCENT_OF_BASIC" as const,
        amount: null, percent: "5", formula: null,
        taxable: false, showOnPayslip: true, includeInCtc: false,
        isStatutory: false, sortOrder: 10,
      };
      const withDeduction = calcPayroll({ ...baseInput, components: [basicComponent, hraComponent, deductComp] });
      const withoutDeduction = calcPayroll(baseInput);

      const dedLine = withDeduction.lines.find(l => l.code === "ADVANCE_RECOVERY");
      expect(dedLine).toBeDefined();
      expect(dedLine!.category).toBe("DEDUCTION");

      const monthlyCtc = 1200000 / 12;
      const basic = monthlyCtc * 0.4;
      expect(parseFloat(dedLine!.amount)).toBeCloseTo(basic * 0.05, 0);

      expect(parseFloat(withDeduction.totals.net)).toBeCloseTo(
        parseFloat(withoutDeduction.totals.net) - parseFloat(dedLine!.amount),
        0,
      );
    });

    it("FORMULA deduction computes correctly and reduces net", () => {
      const formulaDed: ResolvedComponent = {
        id: 31, code: "CUSTOM_DED", name: "Custom Deduction",
        type: "DEDUCTION" as const,
        calcMethod: "FORMULA" as const,
        amount: null, percent: null, formula: "basic * 0.02",
        taxable: false, showOnPayslip: true, includeInCtc: false,
        isStatutory: false, sortOrder: 11,
      };
      const withDed = calcPayroll({ ...baseInput, components: [basicComponent, formulaDed] });
      const withoutDed = calcPayroll({ ...baseInput, components: [basicComponent] });

      const dedLine = withDed.lines.find(l => l.code === "CUSTOM_DED");
      expect(dedLine).toBeDefined();
      expect(dedLine!.category).toBe("DEDUCTION");

      const monthlyCtc = 1200000 / 12;
      const basic = monthlyCtc * 0.4;
      expect(parseFloat(dedLine!.amount)).toBeCloseTo(basic * 0.02, 0);
      expect(parseFloat(withDed.totals.net)).toBeCloseTo(parseFloat(withoutDed.totals.net) - parseFloat(dedLine!.amount), 0);
    });
  });

  describe("(g) ADJUSTMENT clawback", () => {
    it("reduces net pay by the clawback amount", () => {
      const clawback: ResolvedComponent = {
        id: 40, code: "CLAWBACK", name: "Clawback",
        type: "ADJUSTMENT" as const,
        calcMethod: "FIXED" as const,
        amount: "5000.00", percent: null, formula: null,
        taxable: false, showOnPayslip: true, includeInCtc: false,
        isStatutory: false, sortOrder: 900,
      };
      const snapWithout = calcPayroll({ ...baseInput, components: [basicComponent, hraComponent] });
      const snapWith = calcPayroll({ ...baseInput, components: [basicComponent, hraComponent, clawback] });

      const adjLine = snapWith.lines.find(l => l.code === "CLAWBACK");
      expect(adjLine).toBeDefined();
      expect(adjLine!.category).toBe("ADJUSTMENT");

      const netWithout = parseFloat(snapWithout.totals.net);
      const netWith = parseFloat(snapWith.totals.net);
      expect(netWith).toBeCloseTo(netWithout - 5000, 0);
    });
  });

  describe("(h) variance and HIGH_VARIANCE", () => {
    it("populates variance when previous snapshot supplied", () => {
      const prevSnap: CalculationSnapshot = {
        policyVersionId: 1,
        computedAt: "2025-06-01T00:00:00.000Z",
        currency: "INR",
        fxRate: null,
        netPayoutCurrency: null,
        scheduledDays: "30",
        paidDays: "30",
        lopDays: "0",
        overtimeHours: "0",
        lines: [],
        totals: { gross: "50000.00", deductions: "0.00", employerContributions: "0.00", net: "50000.00" },
        variance: null,
      };

      const snap = calcPayroll({
        ...baseInput,
        annualCtcDecimal: "1440000.00",
        previousSnapshot: prevSnap,
      });

      expect(snap.variance).not.toBeNull();
      expect(snap.variance!.netDeltaPercent).not.toBeNull();
    });

    it("HIGH_VARIANCE exception fires when delta exceeds threshold", () => {
      const prevSnap: CalculationSnapshot = {
        policyVersionId: 1,
        computedAt: "2025-06-01T00:00:00.000Z",
        currency: "INR",
        fxRate: null,
        netPayoutCurrency: null,
        scheduledDays: "30",
        paidDays: "30",
        lopDays: "0",
        overtimeHours: "0",
        lines: [],
        totals: { gross: "50000.00", deductions: "0.00", employerContributions: "0.00", net: "50000.00" },
        variance: null,
      };

      const snap = calcPayroll({
        ...baseInput,
        annualCtcDecimal: "1440000.00",
        previousSnapshot: prevSnap,
      });

      const exceptions = detectExceptions({
        orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
        hasProfile: true, hasBankAccount: true, snapshot: snap,
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, payrollVarianceWarnings: true },
        scheduledDays: 30, lopDays: 0, varianceThresholdPercent: 20,
        hasAttendanceInput: true, hasApprovedTaxDeclaration: true,
        isJoiningInMonth: false, isExitInMonth: false, missingFxRate: false,
      });

      expect(exceptions.some(e => e.code === "HIGH_VARIANCE")).toBe(true);
    });
  });
});
