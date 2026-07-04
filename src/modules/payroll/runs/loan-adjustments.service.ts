import { Injectable, Inject } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollLoanAdjustments,
  payrollRuns,
  salaryLoans,
} from "../../../db/schema";
import type { LoanAdjustmentInput } from "./dto/runs.schemas";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { GenerateService } from "./generate.service";

@Injectable()
export class LoanAdjustmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly generateService: GenerateService,
  ) {}

  async createAdjustment(
    orgId: string,
    runId: number,
    actorId: string,
    body: LoanAdjustmentInput,
  ): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
    const runCheck = await this.db
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return { ok: false, reason: "not_found" };
    if (PAYROLL_LOCKED_STATUSES.includes(runCheck[0].status)) return { ok: false, reason: "locked" };

    const loan = await this.db
      .select({ id: salaryLoans.id, userId: salaryLoans.userId, status: salaryLoans.status, orgId: salaryLoans.orgId })
      .from(salaryLoans)
      .where(and(eq(salaryLoans.id, body.loanId), eq(salaryLoans.orgId, orgId)))
      .limit(1);

    if (!loan[0]) return { ok: false, reason: "loan_not_found" };
    if (loan[0].status !== "ACTIVE") return { ok: false, reason: "loan_not_active" };

    const [inserted] = await this.db
      .insert(payrollLoanAdjustments)
      .values({
        orgId,
        loanId: body.loanId,
        runId,
        type: body.type,
        amount: body.amount,
        reason: body.reason,
        createdBy: actorId,
      })
      .returning({ id: payrollLoanAdjustments.id });

    if (!inserted) return { ok: false, reason: "insert_failed" };

    await this.generateService.generateRun(orgId, runId, actorId, true);

    return { ok: true, id: inserted.id };
  }
}
