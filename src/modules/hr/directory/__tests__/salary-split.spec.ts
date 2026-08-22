import {
  DEFAULT_BASIC_PERCENT,
  DEFAULT_HRA_PERCENT,
  DEFAULT_PROFESSIONAL_TAX,
  splitFromTemplate,
} from "../salary-profile-seed.helper";

describe("splitFromTemplate", () => {
  it("turns a template's absolute package into the ratios it implies", () => {
    // basic 60000 + HRA 30% of basic (18000) + allowances 22000 = gross 100000
    const split = splitFromTemplate({
      basicSalary: "60000",
      hraPercent: "30",
      specialAllowance: "22000",
      professionalTax: "350",
    });

    expect(split.basicPercent).toBeCloseTo(60);
    expect(split.hraPercent).toBeCloseTo(30);
    expect(split.professionalTax).toBe(350);
  });

  it("reproduces the template's split at any CTC", () => {
    const split = splitFromTemplate({
      basicSalary: "60000",
      hraPercent: "30",
      specialAllowance: "22000",
    });

    const ctc = 250000;
    const basic = (ctc * split.basicPercent) / 100;
    const hra = (basic * split.hraPercent) / 100;

    expect(basic).toBeCloseTo(150000);
    expect(hra).toBeCloseTo(45000);
    expect(basic + hra).toBeLessThanOrEqual(ctc);
  });

  it("falls back to the documented default when the template is unusable", () => {
    for (const template of [
      { basicSalary: "0", hraPercent: "40" },
      { basicSalary: null, hraPercent: null },
      { basicSalary: "not-a-number", hraPercent: "40" },
    ]) {
      const split = splitFromTemplate(template);
      expect(split.basicPercent).toBe(DEFAULT_BASIC_PERCENT);
      expect(split.hraPercent).toBe(DEFAULT_HRA_PERCENT);
      expect(split.professionalTax).toBe(DEFAULT_PROFESSIONAL_TAX);
    }
  });

  it("keeps the historical default split — 40% basic, 20% of CTC as HRA", () => {
    const ctc = 100000;
    const basic = (ctc * DEFAULT_BASIC_PERCENT) / 100;
    const hra = (basic * DEFAULT_HRA_PERCENT) / 100;
    expect(basic).toBe(40000);
    expect(hra).toBe(20000);
  });
});
