import { payrollSubjectKey } from "./payroll-subject";

describe("payrollSubjectKey", () => {
  it("uses userId when present", () => {
    expect(payrollSubjectKey({ userId: "u-1", workerId: "w-1" })).toBe("u-1");
  });

  it("uses worker prefix when userId is absent", () => {
    expect(payrollSubjectKey({ userId: null, workerId: "w-1" })).toBe("worker:w-1");
  });
});
