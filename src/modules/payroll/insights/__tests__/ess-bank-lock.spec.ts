import { describe, it, expect } from "@jest/globals";

const LOCKED_STATUSES = ["LOCKED", "APPROVED", "PAID", "PAYSLIPS_PUBLISHED"] as const;
type LockedStatus = (typeof LOCKED_STATUSES)[number];

function checkBankLock(activeRunStatus: string | null): { allowed: boolean; reason?: string } {
  if (!activeRunStatus) return { allowed: true };
  if ((LOCKED_STATUSES as readonly string[]).includes(activeRunStatus)) {
    return {
      allowed: false,
      reason: `Bank details are frozen: payroll run is in status ${activeRunStatus}`,
    };
  }
  return { allowed: true };
}

describe("ESS bank details lock — active run guard", () => {
  it("allows bank update when no active run", () => {
    expect(checkBankLock(null).allowed).toBe(true);
  });

  it("allows bank update when run is in PREPARING status", () => {
    expect(checkBankLock("PREPARING").allowed).toBe(true);
  });

  it("allows bank update when run is in PREVIEW_READY status", () => {
    expect(checkBankLock("PREVIEW_READY").allowed).toBe(true);
  });

  it("blocks bank update when run is LOCKED", () => {
    const result = checkBankLock("LOCKED");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("LOCKED");
  });

  it("blocks bank update when run is APPROVED", () => {
    expect(checkBankLock("APPROVED").allowed).toBe(false);
  });

  it("blocks bank update when run is PAID", () => {
    expect(checkBankLock("PAID").allowed).toBe(false);
  });

  it("blocks bank update when run is PAYSLIPS_PUBLISHED", () => {
    expect(checkBankLock("PAYSLIPS_PUBLISHED").allowed).toBe(false);
  });

  it.each(LOCKED_STATUSES)("blocks bank update for all locked status: %s", (status: LockedStatus) => {
    expect(checkBankLock(status).allowed).toBe(false);
  });
});

describe("ESS tax declaration — lockDate enforcement", () => {
  function isSubmissionAllowed(windowStatus: string, lockDate: string | null, today: string): { allowed: boolean; reason?: string } {
    if (windowStatus !== "OPEN") return { allowed: false, reason: "Window is not open" };
    if (lockDate && today > lockDate) {
      return { allowed: false, reason: `Submission deadline was ${lockDate}` };
    }
    return { allowed: true };
  }

  it("allows submission when lockDate is null", () => {
    expect(isSubmissionAllowed("OPEN", null, "2026-03-15").allowed).toBe(true);
  });

  it("allows submission before lockDate", () => {
    expect(isSubmissionAllowed("OPEN", "2026-03-31", "2026-03-15").allowed).toBe(true);
  });

  it("allows submission on lockDate itself", () => {
    expect(isSubmissionAllowed("OPEN", "2026-03-31", "2026-03-31").allowed).toBe(true);
  });

  it("blocks submission after lockDate", () => {
    const result = isSubmissionAllowed("OPEN", "2026-03-31", "2026-04-01");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("2026-03-31");
  });

  it("blocks submission when window is not OPEN", () => {
    expect(isSubmissionAllowed("CLOSED", null, "2026-03-15").allowed).toBe(false);
  });
});

describe("ESS getOwnFnf — DRAFT filter", () => {
  type FnfRow = { id: number; status: string };

  function filterVisibleFnf(rows: FnfRow[]): FnfRow[] {
    return rows.filter((r) => r.status !== "DRAFT");
  }

  it("hides DRAFT settlements from employee view", () => {
    const rows: FnfRow[] = [{ id: 1, status: "DRAFT" }];
    expect(filterVisibleFnf(rows)).toHaveLength(0);
  });

  it("shows PENDING_APPROVAL settlements", () => {
    const rows: FnfRow[] = [{ id: 1, status: "PENDING_APPROVAL" }];
    expect(filterVisibleFnf(rows)).toHaveLength(1);
  });

  it("shows HR_REVIEW settlements", () => {
    const rows: FnfRow[] = [{ id: 1, status: "HR_REVIEW" }];
    expect(filterVisibleFnf(rows)).toHaveLength(1);
  });

  it("shows APPROVED settlements", () => {
    const rows: FnfRow[] = [{ id: 1, status: "APPROVED" }];
    expect(filterVisibleFnf(rows)).toHaveLength(1);
  });

  it("shows PAID settlements", () => {
    const rows: FnfRow[] = [{ id: 1, status: "PAID" }];
    expect(filterVisibleFnf(rows)).toHaveLength(1);
  });

  it("filters only DRAFT from a mixed list", () => {
    const rows: FnfRow[] = [
      { id: 1, status: "DRAFT" },
      { id: 2, status: "APPROVED" },
      { id: 3, status: "PAID" },
    ];
    const visible = filterVisibleFnf(rows);
    expect(visible).toHaveLength(2);
    expect(visible.every((r) => r.status !== "DRAFT")).toBe(true);
  });
});
