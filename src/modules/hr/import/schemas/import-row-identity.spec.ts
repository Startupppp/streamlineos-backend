import { validateRows } from "./entity-row-schemas";
import { findInFileDuplicates } from "./import-row-identity";

/**
 * HRMS-E2E-003c / 004b / 005b / 006b / 007b. Every one of these tickets reported
 * the same shape of failure: a preview that said "N valid, 0 errors" for a file
 * that named the same thing twice. These assertions fail if the in-file identity
 * pass is removed.
 */
describe("in-file duplicate detection", () => {
  const errorFor = (
    entity: Parameters<typeof validateRows>[0],
    rows: Array<Record<string, unknown>>,
    rowNumber: number,
  ): string | null =>
    validateRows(entity, rows).errorRows.find((row) => row.rowNumber === rowNumber)?.error ?? null;

  it("fails the later employee row that repeats an email, whatever its case", () => {
    const result = validateRows("employees", [
      { email: "qa-set1@example.com", firstName: "QA", lastName: "One", joiningDate: "2026-09-02" },
      { email: "QA-SET1@EXAMPLE.COM", firstName: "QA", lastName: "Two", joiningDate: "2026-09-02" },
    ]);

    expect(result.validRows.map((row) => row.rowNumber)).toEqual([1]);
    expect(result.errorRows).toHaveLength(1);
    expect(result.errorRows[0]?.error).toContain("row 1");
    expect(result.errorRows[0]?.error).toContain("email");
  });

  it("fails a repeated employee number even when the emails differ", () => {
    expect(
      errorFor(
        "employees",
        [
          { email: "a@example.com", firstName: "A", lastName: "A", joiningDate: "2026-09-02", employeeNumber: "EMP-QS01" },
          { email: "b@example.com", firstName: "B", lastName: "B", joiningDate: "2026-09-02", employeeNumber: "emp-qs01" },
        ],
        2,
      ),
    ).toContain("employee number");
  });

  it("does not treat two rows without an employee number as colliding", () => {
    const result = validateRows("employees", [
      { email: "a@example.com", firstName: "A", lastName: "A", joiningDate: "2026-09-02" },
      { email: "b@example.com", firstName: "B", lastName: "B", joiningDate: "2026-09-02" },
    ]);
    expect(result.errorRows).toHaveLength(0);
    expect(result.validRows).toHaveLength(2);
  });

  it("fails a second balance for the same employee, leave type and year", () => {
    expect(
      errorFor(
        "leave_balances",
        [
          { employeeEmail: "e@example.com", leaveTypeName: "Casual Leave", balance: 8, year: 2026 },
          { employeeEmail: "e@example.com", leaveTypeName: "Casual Leave", balance: 12, year: 2026 },
        ],
        2,
      ),
    ).toContain("row 1");
  });

  it("fails a second attendance row for the same person-day", () => {
    expect(
      errorFor(
        "attendance",
        [
          { employeeEmail: "e@example.com", date: "2026-09-21", checkIn: "09:30", checkOut: "18:00" },
          { employeeEmail: "e@example.com", date: "2026-09-21", checkIn: "10:00", checkOut: "19:00" },
        ],
        2,
      ),
    ).toContain("employee + date");
  });

  it("fails a repeated asset serial but leaves serial-less rows alone", () => {
    const result = validateRows("assets", [
      { name: "QA Laptop A", type: "LAPTOP", serialNumber: "QA-SN-0001" },
      { name: "QA Laptop A Duplicate Serial", type: "LAPTOP", serialNumber: " qa-sn-0001 " },
      { name: "QA Monitor B", type: "MONITOR" },
      { name: "QA Monitor C", type: "MONITOR" },
    ]);

    expect(result.errorRows.map((row) => row.rowNumber)).toEqual([2]);
    expect(result.validRows.map((row) => row.rowNumber)).toEqual([1, 3, 4]);
  });

  it("fails an exact repeat of a document row", () => {
    const row = {
      employeeEmail: "e@example.com",
      name: "QA Offer Letter",
      type: "OFFER_LETTER",
      fileUrl: "https://example.com/qa-offer.pdf",
      category: "Onboarding",
    };
    const result = validateRows("document_metadata", [row, { ...row }, { ...row, name: "QA ID Proof" }]);

    expect(result.errorRows.map((row) => row.rowNumber)).toEqual([2]);
    expect(result.validRows).toHaveLength(2);
  });

  it("reports duplicates in the preview's topErrors, in row order", () => {
    const result = validateRows("assets", [
      { name: "A", type: "LAPTOP", serialNumber: "S1" },
      { name: "B", type: "" },
      { name: "C", type: "LAPTOP", serialNumber: "S1" },
    ]);
    expect(result.topErrors.map((error) => error.row)).toEqual([2, 3]);
  });

  it("ignores rows the schema already rejected", () => {
    // Both rows repeat a serial, but row 1 has no type, so only row 1's schema
    // error is reported — a duplicate of an unimportable row is not news.
    const duplicates = findInFileDuplicates("assets", [
      { rowNumber: 2, payload: { name: "B", type: "LAPTOP", serialNumber: "S1" } },
    ]);
    expect(duplicates.size).toBe(0);
  });
});
