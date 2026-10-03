import { csvHeader, csvRow, isSafeBankToken } from "../payout-csv";

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
    ).toThrow("Refusing to write a bank file cell outside [A-Za-z0-9 ]");
  });

  it("keeps a hostile payee name inside one row and one cell", () => {
    const row = csvRow(
      "NEFT_CSV", 1, '=cmd"\n2,"Mallory', "123456789012", "HDFC0000001", "INR", 100, "Salary 2026-06",
    );
    expect(row.split("\n")).toHaveLength(1);
    expect(row).toBe('1,"cmd  2, Mallory","123456789012","HDFC0000001",1.00,"Salary 2026-06"');
  });
});

describe("corporate net banking bulk-upload files", () => {
  const header =
    "TransactionType,BeneficiaryName,BeneficiaryAccountNumber,IFSC,Amount,Narration,BeneficiaryEmail";

  it.each([
    ["HDFC_BULK_CSV", "HDFC0000123"],
    ["ICICI_BULK_CSV", "ICIC0000123"],
    ["SBI_BULK_CSV", "SBIN0000123"],
    ["AXIS_BULK_CSV", "UTIB0000123"],
  ] as const)("%s writes the common bulk layout, rupees to two decimals from paise", (format, sameBankIfsc) => {
    expect(csvHeader(format)).toBe(header);
    expect(csvRow(format, 1, "Asha Rao", "123456789012", "KKBK0000958", "INR", 1234567, "Salary 2026-03", "asha@x.test")).toBe(
      'NEFT,"Asha Rao","123456789012","KKBK0000958",12345.67,"Salary 2026-03","asha@x.test"',
    );
    expect(csvRow(format, 2, "Bala", "998877", sameBankIfsc, "INR", 5, "Salary 2026-03")).toBe(
      `IFT,"Bala","998877","${sameBankIfsc}",0.05,"Salary 2026-03",""`,
    );
  });

  it("keeps a hostile email inside its own cell", () => {
    const row = csvRow("HDFC_BULK_CSV", 1, "Asha", "123", "HDFC0000001", "INR", 100, "Salary", '=x"\n,evil');
    expect(row.split("\n")).toHaveLength(1);
    expect(row.endsWith('"x  ,evil"')).toBe(true);
  });
});
