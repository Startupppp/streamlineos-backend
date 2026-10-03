import {
  getIndiaBundleForDate,
  resolvePtMonthly,
  resolveLwf,
  validateLabourCodeWageDefinition,
  calcHraExemptionPaise,
  IN_STATUTORY_2025_04,
  IN_STATUTORY_2026_04,
  getIndiaBundleForMonth,
  calcSlabTaxRupees,
} from "../statutory-registry";
import { calcStatutory } from "../statutory";
import { calcHraForMonth, calcMonthlyTds } from "../hra-tds";

describe("statutory registry (canonical India rules)", () => {
  it("exposes monthly PF wage ceiling (not the misnamed annual field)", () => {
    const b = getIndiaBundleForDate();
    expect(b.pf.monthlyWageCeiling).toBe("15000.00");
    expect(b.pf.legacyMisnamedAnnualField).toBe("21600");
  });

  it("resolves state-aware PT and LWF", () => {
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "TN")).toBe("208.33");
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, null)).toBe("200.00");
    expect(resolveLwf(IN_STATUTORY_2025_04, "MH").employerFixed).toBe("75.00");
    // Expanded sample matrix (still not full India legal pack)
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "DL")).toBe("0.00");
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "RJ")).toBe("200.00");
    expect(resolveLwf(IN_STATUTORY_2025_04, "TN").employeeFixed).toBe("20.00");
    expect(resolveLwf(IN_STATUTORY_2025_04, "GJ").employerFixed).toBe("12.00");
  });

  it("validates Labour Code 50% basic+DA wage definition", () => {
    const ok = validateLabourCodeWageDefinition(6000000, 0, 10000000); // 60%
    expect(ok.ok).toBe(true);
    const bad = validateLabourCodeWageDefinition(3000000, 0, 10000000); // 30%
    expect(bad.ok).toBe(false);
  });

  it("calculates HRA exemption as min of three", () => {
    const { exemptionPaise } = calcHraExemptionPaise({
      basicPaise: 5000000, // 50,000
      hraReceivedPaise: 2000000, // 20,000
      rentPaidPaise: 2500000, // 25,000
      isMetro: true,
    });
    // rent-10%basic = 25000-5000=20000; 50% basic=25000; actual HRA=20000 → 20000
    expect(exemptionPaise).toBe(2000000);
  });

  it("calcStatutory India path uses registry versions and skips contractors", () => {
    const contractor = calcStatutory({
      workerType: "CONTRACTOR",
      toggles: { pf: true, esi: true, professionalTax: true, gratuity: true, lwf: true } as never,
      config: { statutory: {} } as never,
      basicPaise: 2000000,
      grossPaise: 5000000,
      rounding: { mode: "NEAREST", precision: 0 },
    });
    expect(contractor.lines).toHaveLength(0);

    const emp = calcStatutory({
      workerType: "EMPLOYEE",
      toggles: {
        pf: true,
        esi: false,
        professionalTax: true,
        gratuity: true,
        lwf: true,
      } as never,
      config: {
        statutory: {
          pfEmployeePercent: "12",
          pfEmployerPercent: "12",
          pfWageCeiling: "15000.00",
          professionalTaxMonthly: "200.00",
        },
      } as never,
      basicPaise: 2000000,
      grossPaise: 5000000,
      rounding: { mode: "NEAREST", precision: 0 },
      stateCode: "KA",
      month: "2026-03",
    });
    expect(emp.ruleVersion).toBe("IN-2025.04");
    expect(emp.calculationVersion).toBe("1.1.0");
    expect(emp.lines.some((l) => l.code === "EPF_EMPLOYEE")).toBe(true);
    expect(emp.lines.some((l) => l.explain?.steps?.some((s) => s.includes("IN-PF-")))).toBe(true);
  });
});

describe("HRA / TDS helpers", () => {
  it("calcHraForMonth returns decimal string exemption", () => {
    const r = calcHraForMonth({
      basic: "50000.00",
      hraReceived: "20000.00",
      rentPaid: "25000.00",
      city: "Mumbai",
    });
    expect(r.exemption).toBe("20000.00");
  });

  it("calcMonthlyTds projects remaining tax across months", () => {
    const r = calcMonthlyTds({
      monthlyTaxablePaise: 10000000,
      monthsRemainingInFy: 6,
      ytdTaxablePaise: 60000000,
      ytdTdsPaise: 0,
      previousEmployerIncomePaise: 0,
      previousEmployerTdsPaise: 0,
      perquisitesPaise: 0,
      section80cPaise: 0,
      section80dPaise: 0,
      homeLoanInterestPaise: 0,
      section80gPaise: 0,
      hraExemptionPaise: 0,
      regime: "NEW",
      rounding: { mode: "NEAREST", precision: 0 },
    });
    expect(r.ruleYearLabel).toContain("FY");
    expect(r.monthlyTdsPaise).toBeGreaterThanOrEqual(0);
  });

  it("pins form labels to the bundle in force: 24Q/16 for FY2025-26, 138/130 for FY2026-27", () => {
    expect(IN_STATUTORY_2025_04.tds.formLabels).toEqual({
      quarterlyReturn: "Form 24Q",
      annualCertificate: "Form 16",
    });
    expect(IN_STATUTORY_2026_04.tds.formLabels).toEqual({
      quarterlyReturn: "Form 138",
      annualCertificate: "Form 130",
    });
    expect(getIndiaBundleForMonth("2026-03").bundleVersion).toBe("IN-2025.04");
    expect(getIndiaBundleForMonth("2026-04").bundleVersion).toBe("IN-2026.04");
    expect(getIndiaBundleForMonth("2027-01").bundleVersion).toBe("IN-2026.04");
  });

  it("FY2026-27 new-regime rebate zeroes tax up to ₹12L taxable income", () => {
    const regime = IN_STATUTORY_2026_04.tds.newRegime;
    expect(calcSlabTaxRupees(1_200_000, regime)).toBe(0);
    expect(calcSlabTaxRupees(1_300_000, regime)).toBeGreaterThan(0);
    expect(calcSlabTaxRupees(2_400_000, regime)).toBe(300_000);
  });
});

describe("resolvePtMonthly gross slabs", () => {
  it("applies Maharashtra slabs by monthly gross, with the February top-up", () => {
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "MH", 7000, "2026-10")).toBe("0.00");
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "MH", 9000, "2026-10")).toBe("175.00");
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "MH", 50000, "2026-10")).toBe("200.00");
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "MH", 50000, "2027-02")).toBe("300.00");
  });

  it("exempts Karnataka earners below 25,000", () => {
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "KA", 24000, "2026-10")).toBe("0.00");
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "KA", 25000, "2026-10")).toBe("200.00");
  });

  it("walks West Bengal's bands", () => {
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "WB", 12000)).toBe("110.00");
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "WB", 30000)).toBe("150.00");
  });

  it("keeps the flat state amount when no gross is given or the state has no slabs", () => {
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "MH")).toBe("200.00");
    expect(resolvePtMonthly(IN_STATUTORY_2025_04, "TN", 5000)).toBe("208.33");
  });
});
