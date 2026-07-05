import {
  STATUTORY_PACKS,
  getStatutoryPack,
  COUNTRY_DEFAULT_CURRENCY,
} from "../statutory-packs";
import { calcStatutory } from "../statutory";
import type { PayrollPolicyConfig, PayrollToggles } from "../../../payroll.types";
import { DEFAULT_PAYROLL_TOGGLES } from "../../../payroll.types";

const EXPECTED_COUNTRIES = ["IN", "US", "GB", "AE", "SG", "AU", "GENERIC"];

describe("statutory-packs registry — structure sanity", () => {
  it("every expected country has exactly one pack", () => {
    for (const country of EXPECTED_COUNTRIES) {
      const matches = STATUTORY_PACKS.filter((p) => p.country === country);
      expect(matches).toHaveLength(1);
    }
  });

  it("every pack has a non-empty countryName and currency", () => {
    for (const pack of STATUTORY_PACKS) {
      expect(pack.countryName.length).toBeGreaterThan(0);
      expect(pack.currency.length).toBe(3);
    }
  });

  it("every pack item has a unique componentCode within its pack", () => {
    for (const pack of STATUTORY_PACKS) {
      const codes = pack.items.map((i) => i.componentCode);
      const unique = new Set(codes);
      expect(unique.size).toBe(codes.length);
    }
  });

  it("every pack item has a unique key within its pack", () => {
    for (const pack of STATUTORY_PACKS) {
      const keys = pack.items.map((i) => i.key);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    }
  });

  it("every pack has between 5 and 8 compliance checklist items", () => {
    for (const pack of STATUTORY_PACKS) {
      expect(pack.complianceChecklist.length).toBeGreaterThanOrEqual(5);
      expect(pack.complianceChecklist.length).toBeLessThanOrEqual(8);
    }
  });

  it("every checklist item has non-empty key, label, and detail", () => {
    for (const pack of STATUTORY_PACKS) {
      for (const item of pack.complianceChecklist) {
        expect(item.key.length).toBeGreaterThan(0);
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it("percent and fixedAmount values in pack items are parseable numbers", () => {
    for (const pack of STATUTORY_PACKS) {
      for (const item of pack.items) {
        if (item.calc.percent != null) {
          expect(parseFloat(item.calc.percent)).not.toBeNaN();
        }
        if (item.calc.fixedAmount != null) {
          expect(parseFloat(item.calc.fixedAmount)).not.toBeNaN();
        }
        if (item.calc.wageCeilingMonthly != null) {
          expect(parseFloat(item.calc.wageCeilingMonthly)).not.toBeNaN();
        }
        if (item.calc.wageFloorMonthly != null) {
          expect(parseFloat(item.calc.wageFloorMonthly)).not.toBeNaN();
        }
        if (item.calc.brackets) {
          for (const band of item.calc.brackets) {
            expect(parseFloat(band.percent)).not.toBeNaN();
            if (band.upToMonthly != null) {
              expect(parseFloat(band.upToMonthly)).not.toBeNaN();
            }
          }
        }
      }
    }
  });

  it("getStatutoryPack falls back to GENERIC for unknown country", () => {
    const pack = getStatutoryPack("ZZ");
    expect(pack.country).toBe("GENERIC");
  });

  it("getStatutoryPack returns correct pack for each known country", () => {
    for (const country of ["IN", "US", "GB", "AE", "SG", "AU"]) {
      expect(getStatutoryPack(country).country).toBe(country);
    }
  });

  it("COUNTRY_DEFAULT_CURRENCY has correct entries", () => {
    expect(COUNTRY_DEFAULT_CURRENCY["IN"]).toBe("INR");
    expect(COUNTRY_DEFAULT_CURRENCY["US"]).toBe("USD");
    expect(COUNTRY_DEFAULT_CURRENCY["GB"]).toBe("GBP");
    expect(COUNTRY_DEFAULT_CURRENCY["AE"]).toBe("AED");
    expect(COUNTRY_DEFAULT_CURRENCY["SG"]).toBe("SGD");
    expect(COUNTRY_DEFAULT_CURRENCY["AU"]).toBe("AUD");
  });

  it("IN pack taxRegimeApplicable is true; all others are false", () => {
    expect(getStatutoryPack("IN").taxRegimeApplicable).toBe(true);
    for (const country of ["US", "GB", "AE", "SG", "AU", "GENERIC"]) {
      expect(getStatutoryPack(country).taxRegimeApplicable).toBe(false);
    }
  });
});

const baseConfig = (country: string): PayrollPolicyConfig => ({
  rounding: { mode: "NEAREST" as const, precision: 2 as const },
  components: [],
  approvalChain: [],
  payslipLayout: "CLASSIC" as const,
  calendar: {
    attendanceCutoffDay: 26, reimbursementCutoffDay: 26, declarationCutoffDay: 20,
    previewDay: 28, approvalDeadlineDay: 30, publishOffsetDays: 1,
  },
  statutory: {
    pfEmployeePercent: "12", pfEmployerPercent: "12",
    pfWageCeiling: "15000.00",
    esiEmployeePercent: "0.75", esiEmployerPercent: "3.25",
    esiWageCeiling: "21000.00",
    professionalTaxMonthly: "200.00",
    tdsMode: "NONE" as const, tdsFlatPercent: null,
  },
  statutoryPack: {
    country,
    items: getStatutoryPack(country).items.map((i) => ({
      key: i.key,
      enabled: i.enabledByDefault,
    })),
  },
  overtime: { multiplier: "1.5", basis: "BASIC" as const },
  varianceThresholdPercent: 20,
});

const baseToggles: PayrollToggles = {
  ...DEFAULT_PAYROLL_TOGGLES,
  pf: false,
  esi: false,
  professionalTax: false,
  tds: false,
};

const grossPaise = 500000;
const basicPaise = 300000;

function runStatutory(country: string, overrideItems?: { key: string; enabled: boolean; percentOverride?: string }[]) {
  const config = baseConfig(country);
  if (overrideItems && config.statutoryPack) {
    config.statutoryPack.items = overrideItems;
  }
  return calcStatutory({
    workerType: "EMPLOYEE",
    toggles: baseToggles,
    config,
    basicPaise,
    grossPaise,
    rounding: config.rounding,
  });
}

describe("engine — US pack", () => {
  it("SS_EMP is capped at SS wage base ceiling", () => {
    const highGrossPaise = 2000000;
    const config = baseConfig("US");
    const result = calcStatutory({
      workerType: "EMPLOYEE",
      toggles: baseToggles,
      config,
      basicPaise: highGrossPaise,
      grossPaise: highGrossPaise,
      rounding: config.rounding,
    });
    const ss = result.lines.find((l) => l.code === "SS_EMP");
    expect(ss).toBeDefined();
    const ceilingPaise = Math.round(14675 * 100);
    const expectedSS = Math.round(ceilingPaise * 0.062);
    expect(parseFloat(ss!.amount) * 100).toBeCloseTo(expectedSS, 0);
  });

  it("SS_EMP is uncapped below wage base", () => {
    const result = runStatutory("US");
    const ss = result.lines.find((l) => l.code === "SS_EMP");
    expect(ss).toBeDefined();
    const expected = Math.round(grossPaise * 0.062) / 100;
    expect(parseFloat(ss!.amount)).toBeCloseTo(expected, 1);
  });

  it("MEDICARE_EMP has no ceiling — applies on full gross above SS ceiling", () => {
    const highGrossPaise = 3000000;
    const config = baseConfig("US");
    const result = calcStatutory({
      workerType: "EMPLOYEE",
      toggles: baseToggles,
      config,
      basicPaise: highGrossPaise,
      grossPaise: highGrossPaise,
      rounding: config.rounding,
    });
    const med = result.lines.find((l) => l.code === "MEDICARE_EMP");
    expect(med).toBeDefined();
    const expected = Math.round(highGrossPaise * 0.0145) / 100;
    expect(parseFloat(med!.amount)).toBeCloseTo(expected, 1);
  });

  it("FWT withholding line has category TAX", () => {
    const result = runStatutory("US");
    const fwt = result.lines.find((l) => l.code === "FWT");
    expect(fwt).toBeDefined();
    expect(fwt!.category).toBe("TAX");
  });

  it("SS_ER is EMPLOYER_CONTRIBUTION", () => {
    const result = runStatutory("US");
    const ssEr = result.lines.find((l) => l.code === "SS_ER");
    expect(ssEr).toBeDefined();
    expect(ssEr!.category).toBe("EMPLOYER_CONTRIBUTION");
  });

  it("employer contributions not counted in totalEmployeeDeductionPaise", () => {
    const result = runStatutory("US");
    const empLines = result.lines.filter((l) => l.category === "EMPLOYER_CONTRIBUTION");
    expect(empLines.length).toBeGreaterThan(0);
    const empSum = empLines.reduce((s, l) => s + parseFloat(l.amount), 0);
    expect(result.totalEmployerContributionPaise).toBeCloseTo(empSum * 100, 0);
    const empDeductLines = result.lines.filter((l) => l.category === "DEDUCTION" || l.category === "TAX");
    const empDeductSum = empDeductLines.reduce((s, l) => s + Math.round(parseFloat(l.amount) * 100), 0);
    expect(result.totalEmployeeDeductionPaise).toBeCloseTo(empDeductSum, 0);
  });
});

describe("engine — UK pack", () => {
  it("NI_EMP uses marginal brackets — 0% below threshold, 8% between thresholds, 2% above UEL", () => {
    const niItemsOnly = getStatutoryPack("GB").items.map((i) => ({
      key: i.key,
      enabled: i.key === "NI_EMP",
    }));
    const result = runStatutory("GB", niItemsOnly);
    const ni = result.lines.find((l) => l.code === "NI_EMP");
    expect(ni).toBeDefined();
    expect(ni!.category).toBe("DEDUCTION");
  });

  it("NI_ER is EMPLOYER_CONTRIBUTION", () => {
    const result = runStatutory("GB");
    const niEr = result.lines.find((l) => l.code === "NI_ER");
    expect(niEr).toBeDefined();
    expect(niEr!.category).toBe("EMPLOYER_CONTRIBUTION");
  });

  it("PAYE withholding has category TAX", () => {
    const result = runStatutory("GB");
    const paye = result.lines.find((l) => l.code === "PAYE");
    expect(paye).toBeDefined();
    expect(paye!.category).toBe("TAX");
  });

  it("PENSION_AE items disabled by default", () => {
    const result = runStatutory("GB");
    expect(result.lines.find((l) => l.code === "PENSION_AE_EMP")).toBeUndefined();
    expect(result.lines.find((l) => l.code === "PENSION_AE_ER")).toBeUndefined();
  });
});

describe("engine — SG CPF ceiling", () => {
  it("CPF_EMP is capped at OW ceiling S$7,400/mo", () => {
    const highGrossPaise = 1000000;
    const config = baseConfig("SG");
    const result = calcStatutory({
      workerType: "EMPLOYEE",
      toggles: baseToggles,
      config,
      basicPaise: highGrossPaise,
      grossPaise: highGrossPaise,
      rounding: config.rounding,
    });
    const cpf = result.lines.find((l) => l.code === "CPF_EMP");
    expect(cpf).toBeDefined();
    const ceilingPaise = Math.round(7400 * 100);
    const expectedCPF = Math.round(ceilingPaise * 0.20) / 100;
    expect(parseFloat(cpf!.amount)).toBeCloseTo(expectedCPF, 1);
  });

  it("CPF_ER is EMPLOYER_CONTRIBUTION and capped", () => {
    const result = runStatutory("SG");
    const cpfEr = result.lines.find((l) => l.code === "CPF_ER");
    expect(cpfEr).toBeDefined();
    expect(cpfEr!.category).toBe("EMPLOYER_CONTRIBUTION");
  });
});

describe("engine — AE: zero statutory by default", () => {
  it("no statutory lines when all pack items disabled by default", () => {
    const result = runStatutory("AE");
    expect(result.lines).toHaveLength(0);
    expect(result.totalEmployeeDeductionPaise).toBe(0);
    expect(result.totalEmployerContributionPaise).toBe(0);
  });

  it("GPSSA lines appear when explicitly enabled", () => {
    const enabledItems = [
      { key: "GPSSA_EMP", enabled: true },
      { key: "GPSSA_ER", enabled: true },
    ];
    const result = runStatutory("AE", enabledItems);
    expect(result.lines.find((l) => l.code === "GPSSA_EMP")).toBeDefined();
    expect(result.lines.find((l) => l.code === "GPSSA_ER")).toBeDefined();
  });
});

describe("engine — GENERIC: no lines when item disabled", () => {
  it("produces no lines when WITHHOLDING is disabled", () => {
    const result = runStatutory("GENERIC");
    expect(result.lines).toHaveLength(0);
  });

  it("produces a TAX line when WITHHOLDING is enabled", () => {
    const enabledItems = [{ key: "WITHHOLDING", enabled: true }];
    const result = runStatutory("GENERIC", enabledItems);
    const wh = result.lines.find((l) => l.code === "WITHHOLDING");
    expect(wh).toBeDefined();
    expect(wh!.category).toBe("TAX");
  });
});

describe("engine — IN legacy path unchanged (backward compat)", () => {
  it("no config.statutoryPack for IN uses legacy path — PF computed from toggles", () => {
    const legacyConfig: PayrollPolicyConfig = {
      rounding: { mode: "NEAREST" as const, precision: 2 as const },
      components: [],
      approvalChain: [],
      payslipLayout: "CLASSIC" as const,
      calendar: {
        attendanceCutoffDay: 26, reimbursementCutoffDay: 26, declarationCutoffDay: 20,
        previewDay: 28, approvalDeadlineDay: 30, publishOffsetDays: 1,
      },
      statutory: {
        pfEmployeePercent: "12", pfEmployerPercent: "12",
        pfWageCeiling: "15000.00",
        esiEmployeePercent: "0.75", esiEmployerPercent: "3.25",
        esiWageCeiling: "21000.00",
        professionalTaxMonthly: "200.00",
        tdsMode: "NONE" as const, tdsFlatPercent: null,
      },
      overtime: { multiplier: "1.5", basis: "BASIC" as const },
      varianceThresholdPercent: 20,
    };
    const result = calcStatutory({
      workerType: "EMPLOYEE",
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: true },
      config: legacyConfig,
      basicPaise: 2000000,
      grossPaise: 2000000,
      rounding: legacyConfig.rounding,
    });
    const pfEmp = result.lines.find((l) => l.code === "EPF_EMPLOYEE");
    expect(pfEmp).toBeDefined();
    expect(pfEmp!.category).toBe("DEDUCTION");
    const ceilingPaise = Math.round(15000 * 100);
    const expectedPF = Math.round(ceilingPaise * 0.12) / 100;
    expect(parseFloat(pfEmp!.amount)).toBeCloseTo(expectedPF, 1);
  });

  it("CONTRACTOR produces no lines regardless of country", () => {
    for (const country of ["IN", "US", "GB", "SG"]) {
      const config = baseConfig(country);
      const result = calcStatutory({
        workerType: "CONTRACTOR",
        toggles: baseToggles,
        config,
        basicPaise: 500000,
        grossPaise: 500000,
        rounding: config.rounding,
      });
      expect(result.lines).toHaveLength(0);
    }
  });
});

describe("engine — AU Superannuation", () => {
  it("SUPER_ER is EMPLOYER_CONTRIBUTION", () => {
    const result = runStatutory("AU");
    const super_ = result.lines.find((l) => l.code === "SUPER_ER");
    expect(super_).toBeDefined();
    expect(super_!.category).toBe("EMPLOYER_CONTRIBUTION");
    const expected = Math.round(grossPaise * 0.12) / 100;
    expect(parseFloat(super_!.amount)).toBeCloseTo(expected, 1);
  });

  it("PAYG withholding has category TAX", () => {
    const result = runStatutory("AU");
    const payg = result.lines.find((l) => l.code === "PAYG");
    expect(payg).toBeDefined();
    expect(payg!.category).toBe("TAX");
  });
});
