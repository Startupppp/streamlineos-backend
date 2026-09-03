import { Injectable, Inject } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollLineItems, payrollRunEmployees, employeeSalaryProfiles } from "../../../db/schema";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { findRunForMonth } from "./lib/report-builders";
import { AccountingMappingsService } from "./accounting-mappings.service";
import { PAYROLL_READ_CAP, requirePayrollReadWithinCap } from "../lib/query-bounds";

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

    // The journal is one line per (componentId, code, category, costCenter)
    // group, so the grouping is done in SQL: a run writes a line item per
    // employee per component (13 for one employee in the frozen calculation
    // fixture), and reading those rows to fold them in JS put the debit side of
    // the ledger behind a per-row cap while the credit side stayed complete —
    // an unbalanceable journal from roughly 77 employees upward. Grouped, the
    // result set is bounded by the org's component × cost-centre count, not by
    // headcount, and the probe row makes an org past even that bound fail
    // visibly instead of posting silently short figures.
    //
    // The inner join to payroll_run_employees only carries the cost centre;
    // fk_payroll_line_items_run_employee_id_org guarantees it drops nothing.
    //
    // MONEY: amount and net are numeric(15,2) rupees. Both sums are scaled to
    // integer paise inside Postgres (round(x * 100)) and added there exactly,
    // so no float ever holds a running total; `::text` keeps the value out of
    // the driver's float path and Number() reads back an exact integer.
    const [groupRows, netRows, mappings] = await Promise.all([
      this.db
        .select({
          componentId: payrollLineItems.componentId,
          code: payrollLineItems.code,
          category: payrollLineItems.category,
          name: sql<string>`min(${payrollLineItems.name})`,
          costCenter: employeeSalaryProfiles.costCenter,
          totalPaise: sql<string>`sum(round(${payrollLineItems.amount} * 100))::text`,
        })
        .from(payrollLineItems)
        .innerJoin(
          payrollRunEmployees,
          and(
            eq(payrollRunEmployees.id, payrollLineItems.runEmployeeId),
            eq(payrollRunEmployees.orgId, payrollLineItems.orgId),
          ),
        )
        .leftJoin(
          employeeSalaryProfiles,
          and(
            eq(employeeSalaryProfiles.id, payrollRunEmployees.profileId),
            eq(employeeSalaryProfiles.orgId, payrollRunEmployees.orgId),
          ),
        )
        .where(and(eq(payrollLineItems.orgId, orgId), eq(payrollLineItems.runId, run.id)))
        .groupBy(
          payrollLineItems.componentId,
          payrollLineItems.code,
          payrollLineItems.category,
          employeeSalaryProfiles.costCenter,
        )
        // Deterministic order, so the batch sourceHash of an unchanged run is
        // stable and createBatch replays instead of minting a new version.
        .orderBy(
          payrollLineItems.code,
          payrollLineItems.category,
          employeeSalaryProfiles.costCenter,
          payrollLineItems.componentId,
        )
        .limit(PAYROLL_READ_CAP + 1),
      this.db
        .select({
          totalPaise: sql<string>`coalesce(sum(round(${payrollRunEmployees.net} * 100)), 0)::text`,
        })
        .from(payrollRunEmployees)
        .where(
          and(eq(payrollRunEmployees.orgId, orgId), eq(payrollRunEmployees.runId, run.id)),
        ),
      this.accountingMappingsService.getMappings(orgId),
    ]);

    const groups = requirePayrollReadWithinCap(groupRows, "build journal line groups");

    const employerLiabilityAccount =
      mappings.get("EMPLOYER_CONTRIBUTION_LIABILITY") ?? "Statutory Liabilities Payable";

    const lines: JournalLine[] = [];
    const unmappedCodes: string[] = [];

    for (const group of groups) {
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

      // group.totalPaise is integer paise as text; rupees only at the wire edge.
      const amount = Number(group.totalPaise) / 100;
      const costCenter = group.costCenter ?? null;

      lines.push({
        account,
        description: `${group.name} (${group.code})`,
        debit: isDebit ? amount : 0,
        credit: isDebit ? 0 : amount,
        costCenter,
      });

      if (group.category === "EMPLOYER_CONTRIBUTION") {
        lines.push({
          account: employerLiabilityAccount,
          description: `${group.name} payable (${group.code})`,
          debit: 0,
          credit: amount,
          costCenter,
        });
      }
    }

    // Integer paise summed in Postgres over every run employee — no per-employee
    // read, so the credit side cannot fall out of step with the debit side.
    const totalNetPaise = Number(netRows[0]?.totalPaise ?? "0");
    lines.push({
      account: "Salaries Payable",
      description: "Net payable to employees",
      debit: 0,
      credit: totalNetPaise / 100,
      costCenter: null,
    });

    let totalDebitsPaise = 0;
    let totalCreditsPaise = 0;
    for (const line of lines) {
      totalDebitsPaise += Math.round(line.debit * 100);
      totalCreditsPaise += Math.round(line.credit * 100);
    }

    return {
      provisional,
      month,
      lines,
      unmappedCodes: [...new Set(unmappedCodes)],
      totalDebits: totalDebitsPaise / 100,
      totalCredits: totalCreditsPaise / 100,
    };
  }
}
