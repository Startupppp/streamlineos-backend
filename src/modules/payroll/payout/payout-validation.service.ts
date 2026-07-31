import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollRuns, payrollRunEmployees, users } from "../../../db/schema";
import { decryptBankDetails } from "../../../modules/hr/payroll/lib/encryption";
import {
  detectScheme,
  inferCountryFromCurrency,
  validateSchemeCode,
  SCHEME_LABELS,
  type BankScheme,
} from "./lib/bank-validation";

export interface ValidationItem {
  userId: string;
  employeeName: string;
  netAmount: string;
  currency: string;
  maskedAccount: string | null;
  scheme: BankScheme;
  schemeLabel: string;
  errors: string[];
  warnings: string[];
  onHold: boolean;
}

function resolveBankCountry(bankCountry: string | undefined, currency: string): string {
  if (bankCountry && bankCountry.length === 2) return bankCountry;
  return inferCountryFromCurrency(currency);
}

@Injectable()
export class PayoutValidationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async validatePayout(orgId: string, runId: number): Promise<ValidationItem[]> {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      columns: { id: true, status: true },
    });
    if (!run) throw new NotFoundException("Payroll run not found");

    const employees = await this.db
      .select({
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        net: payrollRunEmployees.net,
        currency: payrollRunEmployees.currency,
        status: payrollRunEmployees.status,
        holdReason: payrollRunEmployees.holdReason,
        bankDetails: users.bankDetails,
        name: users.name,
      })
      .from(payrollRunEmployees)
      .leftJoin(users, eq(payrollRunEmployees.userId, users.id))
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    const accountsSeen = new Map<string, string[]>();
    const results: ValidationItem[] = [];

    for (const emp of employees) {
      const bank = decryptBankDetails(emp.bankDetails ?? null);
      const errors: string[] = [];
      const warnings: string[] = [];
      const onHold = emp.status === "HELD" || !!emp.holdReason;

      const country = resolveBankCountry(bank?.bankCountry, emp.currency);
      const scheme = detectScheme(country);
      const schemeLabel = SCHEME_LABELS[scheme];

      if (!bank?.accountNumber) {
        errors.push("Missing bank account");
      }

      if (bank?.accountNumber) {
        const bankCode = bank.ifsc ?? "";
        if (bankCode) {
          const codeValidation = validateSchemeCode(scheme, bankCode);
          if (!codeValidation.valid) {
            const msg = codeValidation.issue ?? `Invalid ${codeValidation.label}`;
            if (emp.currency === "INR") {
              errors.push(msg);
            } else {
              warnings.push(msg);
            }
          }
        } else if (scheme !== "GENERIC") {
          warnings.push(`${schemeLabel} not provided — payout file may be incomplete`);
        }
      }

      const net = parseFloat(emp.net);
      if (net < 0) errors.push("Negative net pay");
      else if (net === 0) warnings.push("Zero net pay");

      if (onHold) warnings.push(`Salary on hold: ${emp.holdReason ?? "reason not specified"}`);

      const maskedAccount = bank?.accountNumber
        ? "XXXX" + bank.accountNumber.slice(-4)
        : null;

      if (bank?.accountNumber) {
        const existing = accountsSeen.get(bank.accountNumber);
        if (existing) {
          warnings.push(`Duplicate bank account with employee(s): ${existing.join(", ")}`);
          existing.push(emp.userId);
        } else {
          accountsSeen.set(bank.accountNumber, [emp.userId]);
        }
      }

      results.push({
        userId: emp.userId,
        employeeName: emp.name ?? emp.userId,
        netAmount: emp.net,
        currency: emp.currency,
        maskedAccount,
        scheme,
        schemeLabel,
        errors,
        warnings,
        onHold,
      });
    }

    return results;
  }
}
