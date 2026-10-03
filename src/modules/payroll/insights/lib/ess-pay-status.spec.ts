import { essPayStatus } from "./ess-pay-status";

describe("essPayStatus", () => {
  it("is not-set-up without a salary profile or payslip", () => {
    expect(essPayStatus(false, false)).toBe("not-set-up");
  });

  it("is awaiting-first-payslip with a salary profile but no published payslip", () => {
    expect(essPayStatus(false, true)).toBe("awaiting-first-payslip");
  });

  it("is paid once any payslip is published, even if the profile was later ended", () => {
    expect(essPayStatus(true, false)).toBe("paid");
    expect(essPayStatus(true, true)).toBe("paid");
  });
});
