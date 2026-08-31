import { matchesAnyPayrollSubjectKey, matchesPayrollSubjectKey } from "./payroll-subject-filter";
import { payrollSubjectFromRunEmployee, payrollSubjectKeyFromRunEmployee } from "./payroll-subject";

describe("payrollSubjectFromRunEmployee", () => {
  it("prefers userId key when both are set", () => {
    expect(
      payrollSubjectKeyFromRunEmployee({ userId: "u-1", workerId: "w-1" }),
    ).toBe("u-1");
  });

  it("uses worker prefix for worker-only rows", () => {
    expect(
      payrollSubjectKeyFromRunEmployee({ userId: null, workerId: "w-1" }),
    ).toBe("worker:w-1");
  });
});

describe("matchesPayrollSubjectKey", () => {
  const workerOnly = { userId: null, workerId: "w-9" };

  it("matches worker-prefixed filter keys", () => {
    expect(matchesPayrollSubjectKey(workerOnly, "worker:w-9")).toBe(true);
    expect(matchesPayrollSubjectKey(workerOnly, "w-9")).toBe(false);
  });

  it("matches user ids for linked subjects", () => {
    expect(matchesPayrollSubjectKey({ userId: "u-2", workerId: "w-2" }, "u-2")).toBe(true);
  });
});

describe("matchesAnyPayrollSubjectKey", () => {
  it("matches when any filter key hits", () => {
    expect(
      matchesAnyPayrollSubjectKey(
        payrollSubjectFromRunEmployee({ userId: null, workerId: "w-3" }),
        ["u-other", "worker:w-3"],
      ),
    ).toBe(true);
  });
});

describe("filterPayeesBySubjectKeys", () => {
  it("filters payees by subject keys", async () => {
    const { filterPayeesBySubjectKeys } = await import("./payroll-run-payee");
    const payees = [
      {
        runEmployeeId: 1,
        subject: { userId: "u-1", workerId: null },
        subjectKey: "u-1",
        displayName: "A",
        email: null,
        employeeId: null,
        designation: null,
        joiningDate: null,
        bankDetails: null,
        taxId: null,
        panNumber: null,
        workerNumber: null,
      },
      {
        runEmployeeId: 2,
        subject: { userId: null, workerId: "w-2" },
        subjectKey: "worker:w-2",
        displayName: "B",
        email: null,
        employeeId: null,
        designation: null,
        joiningDate: null,
        bankDetails: null,
        taxId: null,
        panNumber: null,
        workerNumber: null,
      },
    ];
    expect(filterPayeesBySubjectKeys(payees, ["worker:w-2"]).map((p) => p.runEmployeeId)).toEqual([2]);
  });
});
