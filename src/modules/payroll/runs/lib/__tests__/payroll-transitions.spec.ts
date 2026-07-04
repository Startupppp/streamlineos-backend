import { canTransitionRun, PAYROLL_RUN_TRANSITIONS } from "../../../payroll.types";
import type { PayrollRunStatus } from "../../../payroll.types";

const ALL_STATUSES = Object.keys(PAYROLL_RUN_TRANSITIONS) as PayrollRunStatus[];

describe("PAYROLL_RUN_TRANSITIONS matrix", () => {
  it("every status has an entry in the transition map", () => {
    const expected: PayrollRunStatus[] = [
      "PREPARING", "DRAFT", "PREVIEW_READY", "EXCEPTIONS_FOUND",
      "PENDING_APPROVAL", "APPROVED", "LOCKED", "PAID",
      "PAYSLIPS_PUBLISHED", "CLOSED", "REOPENED",
    ];
    for (const status of expected) {
      expect(PAYROLL_RUN_TRANSITIONS).toHaveProperty(status);
    }
  });

  it("CLOSED has no allowed transitions", () => {
    expect(PAYROLL_RUN_TRANSITIONS["CLOSED"]).toHaveLength(0);
  });

  it("PREPARING transitions only to DRAFT", () => {
    expect(PAYROLL_RUN_TRANSITIONS["PREPARING"]).toEqual(["DRAFT"]);
  });

  it("DRAFT transitions to PREVIEW_READY and EXCEPTIONS_FOUND", () => {
    expect(PAYROLL_RUN_TRANSITIONS["DRAFT"]).toContain("PREVIEW_READY");
    expect(PAYROLL_RUN_TRANSITIONS["DRAFT"]).toContain("EXCEPTIONS_FOUND");
  });

  it("APPROVED can only transition to LOCKED (not directly to PAID)", () => {
    expect(PAYROLL_RUN_TRANSITIONS["APPROVED"]).toContain("LOCKED");
    expect(PAYROLL_RUN_TRANSITIONS["APPROVED"]).not.toContain("PAID");
  });

  it("LOCKED can transition to PAID or REOPENED", () => {
    expect(PAYROLL_RUN_TRANSITIONS["LOCKED"]).toContain("PAID");
    expect(PAYROLL_RUN_TRANSITIONS["LOCKED"]).toContain("REOPENED");
  });

  it("PAID transitions only to PAYSLIPS_PUBLISHED", () => {
    expect(PAYROLL_RUN_TRANSITIONS["PAID"]).toEqual(["PAYSLIPS_PUBLISHED"]);
  });

  it("PAYSLIPS_PUBLISHED transitions only to CLOSED", () => {
    expect(PAYROLL_RUN_TRANSITIONS["PAYSLIPS_PUBLISHED"]).toEqual(["CLOSED"]);
  });

  it("REOPENED transitions only to DRAFT", () => {
    expect(PAYROLL_RUN_TRANSITIONS["REOPENED"]).toEqual(["DRAFT"]);
  });
});

describe("canTransitionRun — legal transitions", () => {
  const legalCases: [PayrollRunStatus, PayrollRunStatus][] = [
    ["PREPARING", "DRAFT"],
    ["DRAFT", "PREVIEW_READY"],
    ["DRAFT", "EXCEPTIONS_FOUND"],
    ["PREVIEW_READY", "PENDING_APPROVAL"],
    ["PREVIEW_READY", "DRAFT"],
    ["PREVIEW_READY", "EXCEPTIONS_FOUND"],
    ["EXCEPTIONS_FOUND", "PREVIEW_READY"],
    ["EXCEPTIONS_FOUND", "DRAFT"],
    ["EXCEPTIONS_FOUND", "PENDING_APPROVAL"],
    ["PENDING_APPROVAL", "APPROVED"],
    ["PENDING_APPROVAL", "PREVIEW_READY"],
    ["APPROVED", "LOCKED"],
    ["LOCKED", "PAID"],
    ["LOCKED", "REOPENED"],
    ["PAID", "PAYSLIPS_PUBLISHED"],
    ["PAYSLIPS_PUBLISHED", "CLOSED"],
    ["REOPENED", "DRAFT"],
  ];

  it.each(legalCases)("canTransitionRun(%s → %s) === true", (from, to) => {
    expect(canTransitionRun(from, to)).toBe(true);
  });
});

describe("canTransitionRun — illegal transitions", () => {
  const illegalCases: [PayrollRunStatus, PayrollRunStatus][] = [
    ["DRAFT", "LOCKED"],
    ["DRAFT", "PAID"],
    ["DRAFT", "CLOSED"],
    ["DRAFT", "APPROVED"],
    ["LOCKED", "DRAFT"],
    ["LOCKED", "PREVIEW_READY"],
    ["LOCKED", "CLOSED"],
    ["PAID", "REOPENED"],
    ["PAID", "LOCKED"],
    ["PAID", "DRAFT"],
    ["CLOSED", "DRAFT"],
    ["CLOSED", "REOPENED"],
    ["CLOSED", "PAID"],
    ["APPROVED", "DRAFT"],
    ["APPROVED", "PAID"],
    ["PAYSLIPS_PUBLISHED", "PAID"],
    ["PAYSLIPS_PUBLISHED", "LOCKED"],
    ["PREPARING", "EXCEPTIONS_FOUND"],
    ["REOPENED", "LOCKED"],
    ["REOPENED", "PAID"],
  ];

  it.each(illegalCases)("canTransitionRun(%s → %s) === false", (from, to) => {
    expect(canTransitionRun(from, to)).toBe(false);
  });
});

describe("canTransitionRun — self-transitions are always false", () => {
  it.each(ALL_STATUSES)("canTransitionRun(%s → %s) === false (self)", (status) => {
    expect(canTransitionRun(status, status)).toBe(false);
  });
});
