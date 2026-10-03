export type EssPayStatus = "not-set-up" | "awaiting-first-payslip" | "paid";

export function essPayStatus(hasPublishedPayslip: boolean, hasActiveSalaryProfile: boolean): EssPayStatus {
  if (hasPublishedPayslip) return "paid";
  return hasActiveSalaryProfile ? "awaiting-first-payslip" : "not-set-up";
}
