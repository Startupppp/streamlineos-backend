import type { PayoutBatchFormat } from "../dto/payout.schemas";

export function defaultFormatFromCurrency(currency: string): PayoutBatchFormat {
  if (currency === "INR") return "NEFT_CSV";
  if (currency === "USD") return "ACH_CSV";
  if (currency === "EUR") return "SEPA_CSV";
  return "GENERIC_CSV";
}

const BANK_BULK_IFSC_PREFIX = {
  HDFC_BULK_CSV: "HDFC",
  ICICI_BULK_CSV: "ICIC",
  SBI_BULK_CSV: "SBIN",
  AXIS_BULK_CSV: "UTIB",
} as const;

const BANK_BULK_HEADER =
  "TransactionType,BeneficiaryName,BeneficiaryAccountNumber,IFSC,Amount,Narration,BeneficiaryEmail";

export function csvHeader(format: PayoutBatchFormat): string {
  switch (format) {
    case "HDFC_BULK_CSV":
    case "ICICI_BULK_CSV":
    case "SBI_BULK_CSV":
    case "AXIS_BULK_CSV":
      return BANK_BULK_HEADER;
    case "NEFT_CSV":
    case "RTGS_CSV":
      return "SrNo,EmployeeName,AccountNumber,IFSCCode,Amount,Narration";
    case "ACH_CSV":
      return "SrNo,EmployeeName,RoutingNumber,AccountNumber,Amount,Narration";
    case "SEPA_CSV":
      return "SrNo,EmployeeName,IBAN,BIC,Currency,Amount,Reference";
    case "GENERIC_CSV":
      return "SrNo,EmployeeName,AccountNumber,BankCode,Currency,Amount,Narration";
  }
}

/**
 * A bank file cell that can only ever hold letters, digits and spaces (IBANs are often stored
 * grouped in fours; a space cannot end a cell or start a formula). Account numbers and bank codes
 * are pasted into the file inside quotes, so one `"` or newline in either closes the cell and
 * writes a second payee row into the file the bank executes (SEC-HRMS-008: an account number
 * of `1","X\n2,"Mallory","99999999",...` did exactly that). Payees failing this are not
 * eligible for a batch; `payout-validation` reports them as an error.
 */
export function isSafeBankToken(value: string): boolean {
  return /^[A-Za-z0-9 ]*$/.test(value);
}

/** Quotes and line breaks end the cell; a leading `= + - @` makes a spreadsheet run it. */
function safePayeeName(name: string): string {
  return name.replace(/["\r\n]/g, " ").replace(/^[=+\-@\t\s]+/, "");
}

export function csvRow(
  format: PayoutBatchFormat,
  idx: number,
  name: string,
  accountNumber: string,
  bankCode: string,
  currency: string,
  amountPaise: number,
  narration: string,
  email: string | null = null,
): string {
  if (!isSafeBankToken(accountNumber) || !isSafeBankToken(bankCode))
    throw new Error("Refusing to write a bank file cell outside [A-Za-z0-9 ]");
  const safeName = safePayeeName(name);
  const amt = (amountPaise / 100).toFixed(2);
  switch (format) {
    case "HDFC_BULK_CSV":
    case "ICICI_BULK_CSV":
    case "SBI_BULK_CSV":
    case "AXIS_BULK_CSV": {
      const txnType = bankCode.toUpperCase().startsWith(BANK_BULK_IFSC_PREFIX[format]) ? "IFT" : "NEFT";
      return `${txnType},"${safeName}","${accountNumber}","${bankCode}",${amt},"${narration}","${safePayeeName(email ?? "")}"`;
    }
    case "NEFT_CSV":
    case "RTGS_CSV":
      return `${idx},"${safeName}","${accountNumber}","${bankCode}",${amt},"${narration}"`;
    case "ACH_CSV":
      return `${idx},"${safeName}","${bankCode}","${accountNumber}",${amt},"${narration}"`;
    case "SEPA_CSV":
      return `${idx},"${safeName}","${accountNumber}","${bankCode}","${currency}",${amt},"${narration}"`;
    case "GENERIC_CSV":
      return `${idx},"${safeName}","${accountNumber}","${bankCode}","${currency}",${amt},"${narration}"`;
  }
}
