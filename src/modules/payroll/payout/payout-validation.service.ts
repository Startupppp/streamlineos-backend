import { Injectable, Inject, NotFoundException } from "@nestjs/common";

import { and, eq } from "drizzle-orm";

import { DRIZZLE } from "../../../db/drizzle.constants";

import type { Db } from "../../../db/drizzle.module";

import { payrollRuns, payrollRunEmployees } from "../../../db/schema";

import {

  detectScheme,

  inferCountryFromCurrency,

  validateSchemeCode,

  SCHEME_LABELS,

  type BankScheme,

} from "./lib/bank-validation";

import { loadRunEmployeePayees } from "../lib/payroll-run-payee";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { PAYROLL_READ_CAP, requirePayrollReadWithinCap } from "../lib/query-bounds";



export interface ValidationItem {

  subjectKey: string;

  userId: string | null;

  workerId: string | null;

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

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly efService: EmploymentFactsService,
  ) {}



  async validatePayout(orgId: string, runId: number): Promise<ValidationItem[]> {

    const run = await this.db.query.payrollRuns.findFirst({

      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),

      columns: { id: true, status: true },

    });

    if (!run) throw new NotFoundException("Payroll run not found");



    const [payees, runEmployees] = await Promise.all([

      loadRunEmployeePayees(this.db, orgId, runId, this.efService),

      requirePayrollReadWithinCap(this.db

        .select({

          id: payrollRunEmployees.id,

          net: payrollRunEmployees.net,

          currency: payrollRunEmployees.currency,

          status: payrollRunEmployees.status,

          holdReason: payrollRunEmployees.holdReason,

        })

        .from(payrollRunEmployees)

        .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)))
        .limit(PAYROLL_READ_CAP + 1), "validate payout employees"),

    ]);



    const runEmployeeById = new Map(runEmployees.map((row) => [row.id, row]));

    const accountsSeen = new Map<string, string[]>();

    const results: ValidationItem[] = [];



    for (const payee of payees) {

      const emp = runEmployeeById.get(payee.runEmployeeId);

      if (!emp) continue;



      const bank = payee.bankDetails;

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

          existing.push(payee.subjectKey);

        } else {

          accountsSeen.set(bank.accountNumber, [payee.subjectKey]);

        }

      }



      results.push({

        subjectKey: payee.subjectKey,

        userId: payee.subject.userId,

        workerId: payee.subject.workerId,

        employeeName: payee.displayName,

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

