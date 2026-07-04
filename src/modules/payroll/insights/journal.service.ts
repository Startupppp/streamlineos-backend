import { Injectable, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollLineItems, payrollRunEmployees } from "../../../db/schema";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { findRunForMonth } from "./lib/report-builders";
import { AccountingMappingsService } from "./accounting-mappings.service";

export interface JournalLine {
  account: string;
  description: string;
  debit: string;
  credit: string;
  costCenter: string | null;
}

export interface JournalResult {
  provisional: boolean;
  month: string;
  lines: JournalLine[];
  unmappedCodes: string[];
  totalDebits: string;
  totalCredits: string;
}

interface LineGroup {
  componentId: number | null;
  code: string;
  category: string;
  name: string;
  total: number;
}

const EMPTY_RESULT = (month: string): JournalResult => ({
  provisional: true,
  month,
  lines: [],
  unmappedCodes: [],
  totalDebits: "0.00",
  totalCredits: "0.00",
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

    const [lineItems, runEmployees, mappings] = await Promise.all([
      this.db
        .select()
        .from(payrollLineItems)
        .where(eq(payrollLineItems.runId, run.id)),
      this.db
        .select({ net: payrollRunEmployees.net })
        .from(payrollRunEmployees)
        .where(eq(payrollRunEmployees.runId, run.id)),
      this.accountingMappingsService.getMappings(orgId),
    ]);

    const groups = new Map<string, LineGroup>();
    for (const item of lineItems) {
      const key = `${item.componentId ?? ""}\0${item.code}\0${item.category}`;
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
        });
      }
    }

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

      const sum = group.total.toFixed(2);
      lines.push({
        account,
        description: `${group.name} (${group.code})`,
        debit: isDebit ? sum : "0.00",
        credit: isDebit ? "0.00" : sum,
        costCenter: null,
      });
    }

    const totalNetNum = runEmployees.reduce((acc, emp) => acc + parseFloat(emp.net), 0);
    lines.push({
      account: "Salaries Payable",
      description: "Net payable to employees",
      debit: "0.00",
      credit: totalNetNum.toFixed(2),
      costCenter: null,
    });

    let totalDebitsNum = 0;
    let totalCreditsNum = 0;
    for (const line of lines) {
      totalDebitsNum += parseFloat(line.debit);
      totalCreditsNum += parseFloat(line.credit);
    }

    return {
      provisional,
      month,
      lines,
      unmappedCodes: [...new Set(unmappedCodes)],
      totalDebits: totalDebitsNum.toFixed(2),
      totalCredits: totalCreditsNum.toFixed(2),
    };
  }
}
