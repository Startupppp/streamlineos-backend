import { Inject, Injectable, NotFoundException, StreamableFile } from "@nestjs/common";
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

  async downloadStatement(orgId: string, settlementId: number): Promise<StreamableFile> {
    const stmt = await this.getStatement(orgId, settlementId);
    const fmtMoney = (v: string) => {
      const n = parseFloat(v) || 0;
      return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const rows = stmt.components
      .map(
        (c) =>
          `<tr>
            <td style="padding:8px 16px;border-bottom:1px solid #eee">${c.label}</td>
            <td style="padding:8px 16px;border-bottom:1px solid #eee;text-align:right${c.type === "deduction" ? ";color:#b91c1c" : ""}">
              ${c.type === "deduction" ? "−" : "+"}${fmtMoney(c.amount)}
            </td>
          </tr>`,
      )
      .join("");

    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>Full &amp; Final Statement</title>
<style>body{font-family:Arial,sans-serif;max-width:720px;margin:32px auto;color:#111}
h1{font-size:22px;color:#0f2b7f}table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 16px;background:#f5f7ff;font-size:11px;text-transform:uppercase;color:#0f2b7f}
.net{background:#0f2b7f;color:#fff;font-size:15px;font-weight:700;padding:12px 16px}</style>
</head><body>
<h1>Full &amp; Final Settlement Statement</h1>
<p><strong>Employee:</strong> ${stmt.employee.name} (${stmt.employee.email})</p>
<p><strong>Status:</strong> ${stmt.status}</p>
<table>
<thead><tr><th>Component</th><th style="text-align:right">Amount (INR)</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td class="net">Net Payable</td><td class="net" style="text-align:right">${fmtMoney(stmt.netPayable)}</td></tr></tfoot>
</table>
<p style="font-size:11px;color:#888;margin-top:24px">This is a system-generated document — Confidential</p>
</body></html>`;

    const buffer = Buffer.from(html, "utf-8");
    return new StreamableFile(buffer, {
      type: "text/html; charset=utf-8",
      disposition: `attachment; filename="fnf-statement-${settlementId}.html"`,
    });
  }
}
