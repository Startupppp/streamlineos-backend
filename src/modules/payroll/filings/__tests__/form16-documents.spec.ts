import { financialYearMonths, isFinancialYear, mergeForm16Rows } from "../lib/form16-documents";

describe("Form 16 year-end pack", () => {
  it("accepts only consecutive financial years", () => {
    expect(isFinancialYear("2025-26")).toBe(true);
    expect(isFinancialYear("2099-00")).toBe(true);
    expect(isFinancialYear("2025-27")).toBe(false);
    expect(isFinancialYear("2025")).toBe(false);
  });

  it("maps a financial year onto April through March", () => {
    expect(financialYearMonths("2025-26")).toEqual({ from: "2025-04", to: "2026-03" });
  });

  it("marks a paid employee with no upload as missing, so missing is derived from payslips", () => {
    const uploadedAt = new Date("2026-05-01T00:00:00Z");
    const people = new Map([
      [1, { employeeName: "Asha", email: "asha@x.test" }],
      [2, { employeeName: "Bala", email: "bala@x.test" }],
      [3, { employeeName: "Chen", email: null }],
    ]);
    const { rows, counts } = mergeForm16Rows(
      [1, 2],
      [
        { userMembershipId: 2, status: "released", fileName: "Form16-2025-26.pdf", fileSizeBytes: 10, uploadedAt, releasedAt: uploadedAt },
        { userMembershipId: 3, status: "uploaded", fileName: "Form16-2025-26.pdf", fileSizeBytes: 10, uploadedAt, releasedAt: null },
      ],
      people,
    );
    expect(rows.map((r) => [r.employeeName, r.status])).toEqual([
      ["Asha", "missing"],
      ["Bala", "released"],
      ["Chen", "uploaded"],
    ]);
    expect(rows[0].fileName).toBeNull();
    expect(counts).toEqual({ missing: 1, uploaded: 1, released: 1 });
  });
});
