import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { salaryLoans, auditLogs, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateLoanInput, UpdateLoanInput } from "./dto/payroll.schemas";

@Injectable()
export class LoansService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listLoans(orgId: string, userId: string, isAdmin: boolean, page = 1, limit = 100) {
    const conditions = [eq(salaryLoans.orgId, orgId)];
    if (!isAdmin) conditions.push(eq(salaryLoans.userId, userId));

    return this.db.query.salaryLoans.findMany({
      where: and(...conditions),
      with: {
        user: {
          columns: { id: true, name: true, firstName: true, lastName: true, email: true, image: true },
        },
      },
      orderBy: [desc(salaryLoans.createdAt)],
      limit,
      offset: (page - 1) * limit,
    });
  }

  async createLoan(orgId: string, userId: string, isAdmin: boolean, body: CreateLoanInput) {
    const emiAmount = body.amount / body.totalEmis;
    const targetUserId = isAdmin && body.userId ? body.userId : userId;

    if (targetUserId !== userId) {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)),
        columns: { id: true },
      });
      if (!member) throw new ForbiddenException("Employee is not a member of this organization");
    }

    const [loan] = await this.db
      .insert(salaryLoans)
      .values({
        orgId,
        userId: targetUserId,
        amount: body.amount.toString(),
        reason: body.reason,
        emiAmount: emiAmount.toFixed(2),
        totalEmis: body.totalEmis,
        paidEmis: 0,
        status: "PENDING",
      })
      .returning();
    return loan;
  }

  async updateLoan(orgId: string, userId: string, loanId: number, body: UpdateLoanInput): Promise<{ ok: boolean }> {
    const existing = await this.db.query.salaryLoans.findFirst({
      where: and(eq(salaryLoans.id, loanId), eq(salaryLoans.orgId, orgId)),
    });
    if (!existing) return { ok: false };

    const patch = {
      ...(body.status && { status: body.status }),
      ...(body.status === "APPROVED" && { approvedBy: userId, approvedAt: new Date() }),
      ...(body.status === "ACTIVE" && { disbursedAt: new Date() }),
      ...(body.paidEmis !== undefined && { paidEmis: body.paidEmis }),
      updatedAt: new Date(),
    };

    if (body.status && body.status !== existing.status) {
      await this.db.transaction(async (tx) => {
        await tx.update(salaryLoans).set(patch).where(and(eq(salaryLoans.id, loanId), eq(salaryLoans.orgId, orgId)));
        await tx.insert(auditLogs).values({
          action: "loan.status_changed",
          userId,
          orgId,
          actorUserId: userId,
          resourceType: "salary_loan",
          resourceId: loanId.toString(),
          metadata: { fromStatus: existing.status, toStatus: body.status },
        });
      });
    } else {
      await this.db.update(salaryLoans).set(patch).where(and(eq(salaryLoans.id, loanId), eq(salaryLoans.orgId, orgId)));
    }

    return { ok: true };
  }
}
