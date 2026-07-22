import { getStatutoryConfig, calculateIncomeTax } from "../lib/statutory-config";
import { IN_STATUTORY_2025_04, resolvePtMonthly } from "../../payroll/runs/lib/statutory-registry";

describe("getStatutoryConfig", () => {
  it("returns India config for country IN", () => {
    const cfg = getStatutoryConfig("IN");
    expect(cfg.country).toBe("IN");
    expect(cfg.currency).toBe("INR");
    expect(cfg.locale).toBe("en-IN");
    expect(cfg.currencySymbol).toBe("₹");
  });

  it("returns India config as fallback for unknown country", () => {
    const cfg = getStatutoryConfig("XX");
    expect(cfg.country).toBe("IN");
  });

  it("returns India config for unknown fiscal year", () => {
    const cfg = getStatutoryConfig("IN", "1999-00");
    expect(cfg.country).toBe("IN");
  });

  describe("IN statutory values — seeded defaults preserve existing behaviour", () => {
    const cfg = getStatutoryConfig("IN");

    it("PF employee percent is 12%", () => {
      expect(cfg.pf.employeePercent).toBe(12);
    });

    it("PF employer percent is 12%", () => {
      expect(cfg.pf.employerPercent).toBe(12);
    });

    it("PF annual contribution ceiling is 21600", () => {
      expect(cfg.pf.annualContributionCeiling).toBe(21600);
    });

    it("ESI employee percent is 0.75%", () => {
      expect(cfg.esi.employeePercent).toBe(0.75);
    });

    it("ESI employer percent is 3.25%", () => {
      expect(cfg.esi.employerPercent).toBe(3.25);
    });

    it("ESI monthly wage ceiling is 21000", () => {
      expect(cfg.esi.monthlyWageCeiling).toBe(21000);
    });

    it("professional tax annual is 2400", () => {
      expect(cfg.professionalTaxAnnual).toBe(2400);
    });

    it("standard deduction is 75000", () => {
      expect(cfg.incomeTax.standardDeduction).toBe(75000);
    });

    it("cess percent is 4", () => {
      expect(cfg.incomeTax.cessPercent).toBe(4);
    });

    it("has 6 new regime slabs", () => {
      expect(cfg.incomeTax.newRegimeSlabs).toHaveLength(6);
    });

    it("has 4 old regime slabs", () => {
      expect(cfg.incomeTax.oldRegimeSlabs).toHaveLength(4);
    });
  });

  describe("consolidation — legacy analytics calculator derives from the canonical registry", () => {
    const cfg = getStatutoryConfig("IN");

    it("PF percents come from the registry bundle", () => {
      expect(cfg.pf.employeePercent).toBe(Number(IN_STATUTORY_2025_04.pf.employeePercent));
      expect(cfg.pf.employerPercent).toBe(Number(IN_STATUTORY_2025_04.pf.employerPercent));
    });

    it("PF annual contribution ceiling comes from the registry's documented legacy field", () => {
      expect(cfg.pf.annualContributionCeiling).toBe(Number(IN_STATUTORY_2025_04.pf.legacyMisnamedAnnualField));
    });

    it("ESI percents and ceiling come from the registry bundle", () => {
      expect(cfg.esi.employeePercent).toBe(Number(IN_STATUTORY_2025_04.esi.employeePercent));
      expect(cfg.esi.employerPercent).toBe(Number(IN_STATUTORY_2025_04.esi.employerPercent));
      expect(cfg.esi.monthlyWageCeiling).toBe(Number(IN_STATUTORY_2025_04.esi.monthlyEligibilityCeiling));
    });

    it("professional tax annual is registry monthly PT × 12", () => {
      expect(cfg.professionalTaxAnnual).toBe(Number(resolvePtMonthly(IN_STATUTORY_2025_04)) * 12);
    });

    it("standard deduction and cess come from the registry TDS rule", () => {
      expect(cfg.incomeTax.standardDeduction).toBe(IN_STATUTORY_2025_04.tds.newRegimeStandardDeductionPaise / 100);
      expect(cfg.incomeTax.cessPercent).toBe(Number(IN_STATUTORY_2025_04.tds.cessPercent));
    });
  });
});

describe("calculateIncomeTax", () => {
  const cfg = getStatutoryConfig("IN");

  it("returns 0 for income below new regime nil slab (3L)", () => {
    const tax = calculateIncomeTax(250000, cfg.incomeTax.newRegimeSlabs);
    expect(tax).toBe(0);
  });

  it("computes 5% for new regime income between 3L–7L", () => {
    const tax = calculateIncomeTax(500000, cfg.incomeTax.newRegimeSlabs);
    expect(tax).toBe(10000);
  });

  it("computes old regime correctly at 5L", () => {
    const tax = calculateIncomeTax(500000, cfg.incomeTax.oldRegimeSlabs);
    expect(tax).toBe(12500);
  });

  it("returns 0 for zero income", () => {
    expect(calculateIncomeTax(0, cfg.incomeTax.newRegimeSlabs)).toBe(0);
  });

  it("handles income above top slab", () => {
    const tax = calculateIncomeTax(2000000, cfg.incomeTax.newRegimeSlabs);
    expect(tax).toBeGreaterThan(0);
  });
});
