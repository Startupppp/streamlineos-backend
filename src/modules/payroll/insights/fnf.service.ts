import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { fnfSettlements, users } from "../../../db/schema";
import { FnfService, type UpdateFnfResult } from "../../hr-payroll/fnf.service";
import type { PatchFnfInput } from "../../hr-payroll/dto/payroll.schemas";

type StatementComponent = {
  label: string;
  amount: string;
  type?: "deduction";
};

type FnfStatement = {
  settlementId: number;
  employee: { id: string; name: string; email: string };
  components: StatementComponent[];
  netPayable: string;
  status: string;
};

@Injectable()
export class FnfInsightsService {
  constructor(
    private readonly fnfService: FnfService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  list(orgId: string, callerId: string, isAdmin: boolean) {
    return this.fnfService.listFnf(orgId, callerId, isAdmin);
  }

  async getOne(orgId: string, settlementId: number) {
    const [row] = await this.db
      .select({
        id: fnfSettlements.id,
        orgId: fnfSettlements.orgId,
        userId: fnfSettlements.userId,
        basicDues: fnfSettlements.basicDues,
        leaveEncashment: fnfSettlements.leaveEncashment,
        bonusDue: fnfSettlements.bonusDue,
        deductions: fnfSettlements.deductions,
        loanRecovery: fnfSettlements.loanRecovery,
        netPayable: fnfSettlements.netPayable,
        status: fnfSettlements.status,
        approvedBy: fnfSettlements.approvedBy,
        notes: fnfSettlements.notes,
        reimbursementsDue: fnfSettlements.reimbursementsDue,
        assetRecovery: fnfSettlements.assetRecovery,
        noticeRecovery: fnfSettlements.noticeRecovery,
        otherDeductions: fnfSettlements.otherDeductions,
        statementPublishedAt: fnfSettlements.statementPublishedAt,
        createdAt: fnfSettlements.createdAt,
        updatedAt: fnfSettlements.updatedAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(fnfSettlements)
      .leftJoin(users, eq(fnfSettlements.userId, users.id))
      .where(and(eq(fnfSettlements.id, settlementId), eq(fnfSettlements.orgId, orgId)));

    if (!row) throw new NotFoundException("F&F settlement not found");
    return row;
  }

  async approve(
    orgId: string,
    settlementId: number,
    actorId: string,
    body: PatchFnfInput,
  ): Promise<UpdateFnfResult> {
    await this.getOne(orgId, settlementId);
    return this.fnfService.updateFnf(orgId, actorId, settlementId, body);
  }

  async getStatement(orgId: string, settlementId: number): Promise<FnfStatement> {
    const row = await this.getOne(orgId, settlementId);

    const components: StatementComponent[] = [
      { label: "Basic Dues", amount: row.basicDues },
      { label: "Leave Encashment", amount: row.leaveEncashment },
      { label: "Bonus Due", amount: row.bonusDue },
      { label: "Reimbursements Due", amount: row.reimbursementsDue },
      { label: "Deductions", amount: row.deductions, type: "deduction" },
      { label: "Loan Recovery", amount: row.loanRecovery, type: "deduction" },
      { label: "Asset Recovery", amount: row.assetRecovery, type: "deduction" },
      { label: "Notice Recovery", amount: row.noticeRecovery, type: "deduction" },
      { label: "Other Deductions", amount: row.otherDeductions, type: "deduction" },
    ];

    return {
      settlementId: row.id,
      employee: {
        id: row.userId,
        name: row.userName ?? "",
        email: row.userEmail ?? "",
      },
      components,
      netPayable: row.netPayable,
      status: row.status,
    };
  }
}
