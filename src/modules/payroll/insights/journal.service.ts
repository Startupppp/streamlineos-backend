import { Injectable, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollLineItems, payrollRunEmployees, employeeSalaryProfiles } from "../../../db/schema";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { findRunForMonth } from "./lib/report-builders";
import { AccountingMappingsService } from "./accounting-mappings.service";

export interface JournalLine {
  account: string;
  description: string;
  debit: number;
  credit: number;
  costCenter: string | null;
}

export interface JournalResult {
  provisional: boolean;
  month: string;
  lines: JournalLine[];
  unmappedCodes: string[];
  totalDebits: number;
  totalCredits: number;
}

interface LineGroup {
  componentId: number | null;
  code: string;
  category: string;
  name: string;
  total: number;
  costCenter: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const EMPTY_RESULT = (month: string): JournalResult => ({
  provisional: true,
  month,
  lines: [],
  unmappedCodes: [],
  totalDebits: 0,
  totalCredits: 0,
});

@Injectable()
export class JournalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly accountingMappingsService: AccountingMappingsService,
  ) {}

  async buildJournal(orgId: string, month: string): Promise<JournalResult> {
    const run = await findRunForMonth(this.db, orgId, month);
    if (run === null) return EMPTY_RESULT(month);

    const provisional = !PAYROLL_LOCKED_STATUSES.includes(run.status);

    const [lineItems, runEmployees, empCostCenters, mappings] = await Promise.all([
      this.db
        .select({
          runEmployeeId: payrollLineItems.runEmployeeId,
          componentId: payrollLineItems.componentId,
          code: payrollLineItems.code,
          category: payrollLineItems.category,
          name: payrollLineItems.name,
          amount: payrollLineItems.amount,
        })
        .from(payrollLineItems)
        .where(eq(payrollLineItems.runId, run.id)),
      this.db
        .select({ net: payrollRunEmployees.net })
        .from(payrollRunEmployees)
        .where(eq(payrollRunEmployees.runId, run.id)),
      this.db
        .select({
          runEmployeeId: payrollRunEmployees.id,
          costCenter: employeeSalaryProfiles.costCenter,
        })
        .from(payrollRunEmployees)
        .leftJoin(
          employeeSalaryProfiles,
          eq(payrollRunEmployees.profileId, employeeSalaryProfiles.id),
        )
        .where(eq(payrollRunEmployees.runId, run.id)),
      this.accountingMappingsService.getMappings(orgId),
    ]);

    const costCenterMap = new Map<number, string | null>();
    for (const e of empCostCenters) {
      costCenterMap.set(e.runEmployeeId, e.costCenter ?? null);
    }

    const groups = new Map<string, LineGroup>();
    for (const item of lineItems) {
      const costCenter = costCenterMap.get(item.runEmployeeId) ?? null;
      const key = `${item.componentId ?? ""}\0${item.code}\0${item.category}\0${costCenter ?? ""}`;
      const existing = groups.get(key);
      if (existing !== undefined) {
        existing.total += parseFloat(item.amount);
      } else {
        groups.set(key, {
          componentId: item.componentId,
          code: item.code,
          category: item.category,
          name: item.name,
          total: parseFloat(item.amount),
          costCenter,
        });
      }
    }

    const employerLiabilityAccount =
      mappings.get("EMPLOYER_CONTRIBUTION_LIABILITY") ?? "Statutory Liabilities Payable";

    const lines: JournalLine[] = [];
    const unmappedCodes: string[] = [];

    for (const group of groups.values()) {
      const cidKey = group.componentId !== null ? String(group.componentId) : undefined;
      const ledgerFromCid = cidKey !== undefined ? mappings.get(cidKey) : undefined;
      const ledgerFromCat = mappings.get(group.category);

      let account: string;
      if (ledgerFromCid !== undefined) {
        account = ledgerFromCid;
      } else if (ledgerFromCat !== undefined) {
        account = ledgerFromCat;
      } else {
        account = `UNMAPPED:${group.code}`;
        unmappedCodes.push(account);
      }

      const isDebit =
        group.category === "EARNING" ||
        group.category === "REIMBURSEMENT" ||
        group.category === "EMPLOYER_CONTRIBUTION";

      const amount = round2(group.total);

      lines.push({
        account,
        description: `${group.name} (${group.code})`,
        debit: isDebit ? amount : 0,
        credit: isDebit ? 0 : amount,
        costCenter: group.costCenter,
      });

      if (group.category === "EMPLOYER_CONTRIBUTION") {
        lines.push({
          account: employerLiabilityAccount,
          description: `${group.name} payable (${group.code})`,
          debit: 0,
          credit: amount,
          costCenter: group.costCenter,
        });
      }
    }

    const totalNetNum = runEmployees.reduce((acc, emp) => acc + parseFloat(emp.net), 0);
    lines.push({
      account: "Salaries Payable",
      description: "Net payable to employees",
      debit: 0,
      credit: round2(totalNetNum),
      costCenter: null,
    });

    let totalDebitsNum = 0;
    let totalCreditsNum = 0;
    for (const line of lines) {
      totalDebitsNum += line.debit;
      totalCreditsNum += line.credit;
    }

    return {
      provisional,
      month,
      lines,
      unmappedCodes: [...new Set(unmappedCodes)],
      totalDebits: round2(totalDebitsNum),
      totalCredits: round2(totalCreditsNum),
    };
  }
}
