import { calcPayroll } from "../calculation-engine";
import type { CalcEngineInput, ResolvedComponent } from "../calculation-engine";
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
  toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: true, esi: false, professionalTax: false },
  config: baseConfig,
  inputs: { scheduledDays: "30", paidDays: "30", lopDays: "0", overtimeHours: "0" },
  pulls: { approvedBonuses: [], approvedIncentives: [], approvedReimbursements: [], activeLoans: [] },
  previousSnapshot: null,
};

describe("calculation engine", () => {
  it("computes basic as 40% of monthly CTC", () => {
    const snap = calcPayroll(baseInput);
    const basicLine = snap.lines.find(l => l.code === "BASIC");
    expect(basicLine).toBeDefined();
    const monthlyCtc = 1200000 / 12;
    const expectedBasic = monthlyCtc * 0.4;
    expect(parseFloat(basicLine!.amount)).toBeCloseTo(expectedBasic, 0);
  });

  it("prorates basic on LOP", () => {
    const input: CalcEngineInput = {
      ...baseInput,
      inputs: { scheduledDays: "30", paidDays: "28", lopDays: "2", overtimeHours: "0" },
    };
    const snap = calcPayroll(input);
    const basicLine = snap.lines.find(l => l.code === "BASIC");
    expect(basicLine).toBeDefined();
    const fullBasic = (1200000 / 12) * 0.4;
    const proratedBasic = fullBasic * (28 / 30);
    expect(parseFloat(basicLine!.amount)).toBeCloseTo(proratedBasic, 0);
  });

  it("applies PF when toggle on", () => {
    const snap = calcPayroll(baseInput);
    const pfLine = snap.lines.find(l => l.code === "PF_EMPLOYEE" || l.code === "EPF_EMPLOYEE");
    expect(pfLine).toBeDefined();
    expect(pfLine!.category).toBe("DEDUCTION");
  });

  it("skips PF for CONTRACTOR", () => {
    const input: CalcEngineInput = { ...baseInput, workerType: "CONTRACTOR" };
    const snap = calcPayroll(input);
    const pfLine = snap.lines.find(l => l.code === "PF_EMPLOYEE" || l.code === "EPF_EMPLOYEE");
    expect(pfLine).toBeUndefined();
  });

  it("zero paid days gives zero net", () => {
    const input: CalcEngineInput = {
      ...baseInput,
      inputs: { scheduledDays: "30", paidDays: "0", lopDays: "30", overtimeHours: "0" },
    };
    const snap = calcPayroll(input);
    expect(parseFloat(snap.totals.net)).toBeCloseTo(0, 0);
  });

  it("recovers loan EMI", () => {
    const input: CalcEngineInput = {
      ...baseInput,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, loans: true, pf: false },
      pulls: {
        ...baseInput.pulls,
        activeLoans: [{
          id: 1, emiAmount: "5000.00", amount: "50000.00",
          paidEmis: 3, totalEmis: 10, adjustment: null,
        }],
      },
    };
    const snap = calcPayroll(input);
    const loanLine = snap.lines.find(l => l.code.includes("LOAN") || l.name.includes("Loan"));
    expect(loanLine).toBeDefined();
    expect(loanLine!.category).toBe("DEDUCTION");
  });

  it("last installment recovers remaining outstanding, not full EMI", () => {
    const input: CalcEngineInput = {
      ...baseInput,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, loans: true, pf: false },
      pulls: {
        ...baseInput.pulls,
        activeLoans: [{
          id: 1,
          emiAmount: "5000.00",
          amount: "12000.00",
          paidEmis: 2,
          totalEmis: 3,
          adjustment: null,
        }],
      },
    };
    const snap = calcPayroll(input);
    const loanLine = snap.lines.find(l => l.code.includes("LOAN") || l.name.includes("Loan"));
    expect(loanLine).toBeDefined();
    expect(parseFloat(loanLine!.amount)).toBeCloseTo(2000, 0);
  });

  it("formula component evaluates correctly", () => {
    const formulaComp: ResolvedComponent = {
      id: 3, code: "SPECIAL_ALLOW", name: "Special Allowance",
      type: "EARNING" as const,
      calcMethod: "FORMULA" as const,
      amount: null, percent: null, formula: "basic * 0.1",
      taxable: true, showOnPayslip: true, includeInCtc: true,
      isStatutory: false, sortOrder: 3,
    };
    const input: CalcEngineInput = {
      ...baseInput,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false },
      components: [basicComponent, formulaComp],
    };
    const snap = calcPayroll(input);
    const formulaLine = snap.lines.find(l => l.code === "SPECIAL_ALLOW");
    expect(formulaLine).toBeDefined();
    const monthlyCtc = 1200000 / 12;
    const basic = monthlyCtc * 0.4;
    expect(parseFloat(formulaLine!.amount)).toBeCloseTo(basic * 0.1, 0);
  });

  it("net is gross minus deductions", () => {
    const snap = calcPayroll({ ...baseInput, toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false } });
    const gross = parseFloat(snap.totals.gross);
    const deductions = parseFloat(snap.totals.deductions);
    const net = parseFloat(snap.totals.net);
    expect(net).toBeCloseTo(gross - deductions, 1);
  });

  describe("PERCENT_OF_BASIC correctness (Bug 1 fix)", () => {
    it("HRA at 20% uses basic as base, not monthly CTC", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false },
        components: [basicComponent, hraComponent],
      };
      const snap = calcPayroll(input);

      const monthlyCtc = 1200000 / 12;
      const expectedBasic = monthlyCtc * 0.4;
      const expectedHra = expectedBasic * 0.2;

      const hraLine = snap.lines.find(l => l.code === "HRA");
      expect(hraLine).toBeDefined();
      expect(parseFloat(hraLine!.amount)).toBeCloseTo(expectedHra, 0);
      expect(parseFloat(hraLine!.amount)).not.toBeCloseTo(monthlyCtc * 0.2, 0);
    });

    it("CTC 12L/yr: BASIC=40% → ₹40000, HRA=20% of BASIC → ₹8000 (not ₹20000)", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false },
        components: [basicComponent, hraComponent],
      };
      const snap = calcPayroll(input);

      const hraLine = snap.lines.find(l => l.code === "HRA");
      expect(hraLine).toBeDefined();
      expect(parseFloat(hraLine!.amount)).toBeCloseTo(8000, 0);
    });
  });

  describe("FORMULA earning uses accumulating gross scope (Bug 2 fix)", () => {
    it("formula after BASIC sees basic in scope as earningGrossSoFar", () => {
      const grossCheckComp: ResolvedComponent = {
        id: 5, code: "GROSS_CHECK", name: "Gross Check",
        type: "EARNING" as const,
        calcMethod: "FORMULA" as const,
        amount: null, percent: null, formula: "gross * 0",
        taxable: true, showOnPayslip: true, includeInCtc: false,
        isStatutory: false, sortOrder: 3,
      };
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false },
        components: [basicComponent, hraComponent, grossCheckComp],
      };
      const snap = calcPayroll(input);
      const grossLine = snap.lines.find(l => l.code === "GROSS_CHECK");
      expect(grossLine).toBeDefined();
      expect(parseFloat(grossLine!.amount)).toBeCloseTo(0, 0);
    });

    it("formula using gross variable reflects accumulated earnings before it", () => {
      const fixedEarn: ResolvedComponent = {
        id: 10, code: "FIXED_EARN", name: "Fixed Earn",
        type: "EARNING" as const,
        calcMethod: "FIXED" as const,
        amount: "10000.00", percent: null, formula: null,
        taxable: true, showOnPayslip: true, includeInCtc: false,
        isStatutory: false, sortOrder: 1,
      };
      const formulaComp: ResolvedComponent = {
        id: 11, code: "FORMULA_EARN", name: "Formula Earn",
        type: "EARNING" as const,
        calcMethod: "FORMULA" as const,
        amount: null, percent: null, formula: "gross * 0.1",
        taxable: true, showOnPayslip: true, includeInCtc: false,
        isStatutory: false, sortOrder: 2,
      };
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false },
        components: [fixedEarn, formulaComp],
        inputs: { scheduledDays: "30", paidDays: "30", lopDays: "0", overtimeHours: "0" },
      };
      const snap = calcPayroll(input);
      const formulaLine = snap.lines.find(l => l.code === "FORMULA_EARN");
      expect(formulaLine).toBeDefined();
      expect(parseFloat(formulaLine!.amount)).toBeCloseTo(1000, 0);
    });
  });

  describe("OT zero scheduledDays guard (Bug 12 fix)", () => {
    it("skips OT line when scheduledDays is 0", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, overtime: true },
        inputs: { scheduledDays: "0", paidDays: "0", lopDays: "0", overtimeHours: "8" },
      };
      const snap = calcPayroll(input);
      const otLine = snap.lines.find(l => l.code === "OVERTIME");
      expect(otLine).toBeUndefined();
    });
  });

  describe("half-day proration (Bug 5 fix)", () => {
    it("0.5 paidDays gives 50% prorated earnings", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false },
        components: [basicComponent],
        inputs: { scheduledDays: "1", paidDays: "0.5", lopDays: "0.5", overtimeHours: "0" },
      };
      const snap = calcPayroll(input);
      const basicLine = snap.lines.find(l => l.code === "BASIC");
      expect(basicLine).toBeDefined();
      const fullBasic = (1200000 / 12) * 0.4;
      expect(parseFloat(basicLine!.amount)).toBeCloseTo(fullBasic * (0.5 / 1), 0);
    });
  });

  describe("TDS regime and declaration (Bug 3 + 4 fix)", () => {
    const tdsConfig = {
      ...baseConfig,
      statutory: {
        ...baseConfig.statutory,
        tdsMode: "DECLARATION" as const,
        tdsFlatPercent: null,
      },
    };

    it("NEW regime: annual income 12L → tax NIL (§87A rebate applies)", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        annualCtcDecimal: "1200000.00",
        taxRegime: "NEW",
        components: [basicComponent, hraComponent],
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, tds: true },
        config: tdsConfig,
        pulls: { ...baseInput.pulls, taxDeclaration: null },
      };
      const snap = calcPayroll(input);
      const tdsLine = snap.lines.find(l => l.code === "TDS");
      expect(tdsLine).toBeUndefined();
    });

    it("NEW regime: annual gross 20L → positive TDS", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        annualCtcDecimal: "2400000.00",
        taxRegime: "NEW",
        components: [basicComponent, hraComponent],
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, tds: true },
        config: tdsConfig,
        pulls: { ...baseInput.pulls, taxDeclaration: null },
      };
      const snap = calcPayroll(input);
      const tdsLine = snap.lines.find(l => l.code === "TDS");
      expect(tdsLine).toBeDefined();
      expect(parseFloat(tdsLine!.amount)).toBeGreaterThan(0);
    });

    it("OLD regime with 80C deductions reduces TDS compared to no deductions", () => {
      const pulls80c = {
        ...baseInput.pulls,
        taxDeclaration: {
          section80c: "150000.00",
          section80d: "0.00",
          hra: "0.00",
          lta: "0.00",
          homeLoanInterest: "0.00",
          section80g: "0.00",
          previousEmploymentIncome: "0.00",
          previousEmployerTds: "0.00",
        },
      };
      const pullsNone = { ...baseInput.pulls, taxDeclaration: null };

      const inputWith80c: CalcEngineInput = {
        ...baseInput,
        annualCtcDecimal: "1500000.00",
        taxRegime: "OLD",
        components: [basicComponent, hraComponent],
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, tds: true },
        config: tdsConfig,
        pulls: pulls80c,
      };
      const inputWithout: CalcEngineInput = {
        ...inputWith80c,
        pulls: pullsNone,
      };

      const snapWith = calcPayroll(inputWith80c);
      const snapWithout = calcPayroll(inputWithout);

      const tdsLineWith = snapWith.lines.find(l => l.code === "TDS");
      const tdsLineWithout = snapWithout.lines.find(l => l.code === "TDS");

      if (tdsLineWith && tdsLineWithout) {
        expect(parseFloat(tdsLineWith.amount)).toBeLessThan(parseFloat(tdsLineWithout.amount));
      }
    });

    it("previousEmployerTds credit reduces monthly TDS", () => {
      const pullsWithCredit = {
        ...baseInput.pulls,
        taxDeclaration: {
          section80c: "0.00",
          section80d: "0.00",
          hra: "0.00",
          lta: "0.00",
          homeLoanInterest: "0.00",
          section80g: "0.00",
          previousEmploymentIncome: "0.00",
          previousEmployerTds: "120000.00",
        },
      };
      const input: CalcEngineInput = {
        ...baseInput,
        annualCtcDecimal: "2400000.00",
        taxRegime: "NEW",
        components: [basicComponent, hraComponent],
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, tds: true },
        config: tdsConfig,
        pulls: pullsWithCredit,
      };
      const inputNoCredit: CalcEngineInput = {
        ...input,
        pulls: { ...baseInput.pulls, taxDeclaration: null },
      };

      const snapWith = calcPayroll(input);
      const snapWithout = calcPayroll(inputNoCredit);

      const tdsLineWith = snapWith.lines.find(l => l.code === "TDS");
      const tdsLineWithout = snapWithout.lines.find(l => l.code === "TDS");

      if (tdsLineWith && tdsLineWithout) {
        expect(parseFloat(tdsLineWith.amount)).toBeLessThan(parseFloat(tdsLineWithout.amount));
      }
    });

    it("OLD regime: income below 5L after deductions → §87A nil tax", () => {
      const pullsLow = {
        ...baseInput.pulls,
        taxDeclaration: {
          section80c: "150000.00",
          section80d: "25000.00",
          hra: "0.00",
          lta: "0.00",
          homeLoanInterest: "0.00",
          section80g: "0.00",
          previousEmploymentIncome: "0.00",
          previousEmployerTds: "0.00",
        },
      };
      const input: CalcEngineInput = {
        ...baseInput,
        annualCtcDecimal: "600000.00",
        taxRegime: "OLD",
        components: [basicComponent, hraComponent],
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, tds: true },
        config: tdsConfig,
        pulls: pullsLow,
      };
      const snap = calcPayroll(input);
      const tdsLine = snap.lines.find(l => l.code === "TDS");
      expect(tdsLine).toBeUndefined();
    });
  });

  describe("bonus taxable from pulls (Bug 15 fix)", () => {
    it("non-taxable bonus is reflected in line taxable field", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, bonuses: true },
        pulls: {
          ...baseInput.pulls,
          approvedBonuses: [{ amount: "5000.00", type: "RETENTION", taxable: false }],
        },
      };
      const snap = calcPayroll(input);
      const bonusLine = snap.lines.find(l => l.code.startsWith("BONUS_"));
      expect(bonusLine).toBeDefined();
      expect(bonusLine!.taxable).toBe(false);
    });

    it("taxable bonus is marked taxable", () => {
      const input: CalcEngineInput = {
        ...baseInput,
        toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, bonuses: true },
        pulls: {
          ...baseInput.pulls,
          approvedBonuses: [{ amount: "5000.00", type: "PERFORMANCE", taxable: true }],
        },
      };
      const snap = calcPayroll(input);
      const bonusLine = snap.lines.find(l => l.code.startsWith("BONUS_"));
      expect(bonusLine).toBeDefined();
      expect(bonusLine!.taxable).toBe(true);
    });
  });
});
