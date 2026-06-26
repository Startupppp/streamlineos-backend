import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { salaryLoans } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateLoanInput, UpdateLoanInput } from "./dto/payroll.schemas";

@Injectable()
export class LoansService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listLoans(orgId: string, userId: string, isAdmin: boolean) {
    const conditions = [eq(salaryLoans.orgId, orgId)];
    if (!isAdmin) conditions.push(eq(salaryLoans.userId, userId));

    return this.db.query.salaryLoans.findMany({
      where: and(...conditions),
      with: { user: true },
      orderBy: [desc(salaryLoans.createdAt)],
    });
  }

  async createLoan(orgId: string, userId: string, isAdmin: boolean, body: CreateLoanInput) {
    const emiAmount = body.amount / body.totalEmis;
    const targetUserId = isAdmin && body.userId ? body.userId : userId;

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

    await this.db
      .update(salaryLoans)
      .set({
        ...(body.status && { status: body.status }),
        ...(body.status === "APPROVED" && { approvedBy: userId, approvedAt: new Date() }),
        ...(body.status === "ACTIVE" && { disbursedAt: new Date() }),
        ...(body.paidEmis !== undefined && { paidEmis: body.paidEmis }),
        updatedAt: new Date(),
      })
      .where(eq(salaryLoans.id, loanId));

    return { ok: true };
  }
}
