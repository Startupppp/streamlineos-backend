import { csvRow, isSafeBankToken } from "../payout-csv";

/**
 * SEC-HRMS-008. The bank payout file is built by string concatenation, and an account number
 * reached it verbatim. One stored value added a whole payee to the file the bank executes.
 */
describe("payout CSV cells", () => {
  const injected = '1","X\n2,"Mallory","99999999","HDFC0000001",500000.00,"';

  it("refuses an account number or bank code that could leave its cell", () => {
    expect(isSafeBankToken(injected)).toBe(false);
    expect(isSafeBankToken('=HYPERLINK("http://evil")')).toBe(false);
    expect(isSafeBankToken("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(isSafeBankToken("")).toBe(true);
    expect(() =>
      csvRow("NEFT_CSV", 1, "Payee", injected, "HDFC0000001", "INR", 100, "Salary 2026-06"),
    ).toThrow();
  });

  it("keeps a hostile payee name inside one row and one cell", () => {
    const row = csvRow(
      "NEFT_CSV", 1, '=cmd"\n2,"Mallory', "123456789012", "HDFC0000001", "INR", 100, "Salary 2026-06",
    );
    expect(row.split("\n")).toHaveLength(1);
    expect(row).toBe('1,"cmd  2, Mallory","123456789012","HDFC0000001",1.00,"Salary 2026-06"');
  });
});
