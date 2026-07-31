import type { PayoutBatchFormat } from "../dto/payout.schemas";

export function defaultFormatFromCurrency(currency: string): PayoutBatchFormat {
  if (currency === "INR") return "NEFT_CSV";
  if (currency === "USD") return "ACH_CSV";
  if (currency === "EUR") return "SEPA_CSV";
  return "GENERIC_CSV";
}

export function csvHeader(format: PayoutBatchFormat): string {
  switch (format) {
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

export function csvRow(
  format: PayoutBatchFormat,
  idx: number,
  name: string,
  accountNumber: string,
  bankCode: string,
  currency: string,
  amountPaise: number,
  narration: string,
): string {
  const safeName = name.replace(/"/g, "");
  const amt = (amountPaise / 100).toFixed(2);
  switch (format) {
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
