import {
  createSalaryStructureTemplateSchema,
  updateSalaryStructureTemplateSchema,
} from "./payroll.schemas";

const VALID = {
  name: "Senior Engineer L3",
  basicSalary: "50000",
  hraPercent: "40",
  specialAllowance: "0",
  medicalAllowance: "0",
  travelAllowance: "0",
  otherAllowances: "0",
  pfDeductionPercent: "12",
  professionalTax: "200",
  effectiveFrom: "2026-10-01",
  isActive: true,
};

describe("BUG-008 the salary template endpoint rejects negative components", () => {
  it("accepts a well-formed template, so the rejections below are not passing on a schema that refuses everything", () => {
    expect(createSalaryStructureTemplateSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    "basicSalary",
    "hraPercent",
    "specialAllowance",
    "medicalAllowance",
    "travelAllowance",
    "otherAllowances",
    "pfDeductionPercent",
    "professionalTax",
  ])("rejects -1 in %s", (field) => {
    const parsed = createSalaryStructureTemplateSchema.safeParse({
      ...VALID,
      [field]: "-1",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a negative component on update too, so the guard cannot be walked around by editing", () => {
    expect(
      updateSalaryStructureTemplateSchema.safeParse({ specialAllowance: "-1" }).success,
    ).toBe(false);
  });

  it("accepts zero in every component, because zero is not negative", () => {
    expect(
      createSalaryStructureTemplateSchema.safeParse({
        ...VALID,
        specialAllowance: "0",
        pfDeductionPercent: "0",
        professionalTax: "0",
      }).success,
    ).toBe(true);
  });

  it.each(["hraPercent", "pfDeductionPercent"])(
    "rejects %s above 100, which is a percentage and not an amount",
    (field) => {
      expect(
        createSalaryStructureTemplateSchema.safeParse({ ...VALID, [field]: "101" }).success,
      ).toBe(false);
    },
  );

  it("still rejects a non-numeric amount, the case that was already guarded", () => {
    expect(
      createSalaryStructureTemplateSchema.safeParse({ ...VALID, basicSalary: "abc" }).success,
    ).toBe(false);
  });
});
