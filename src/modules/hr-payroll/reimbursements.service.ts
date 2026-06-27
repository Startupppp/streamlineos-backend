import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { reimbursements, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AutomationService } from "../automation/automation.service";
import type { CreateReimbursementInput, PatchReimbursementInput } from "./dto/payroll.schemas";

export type UpdateReimbursementResult =
  | { ok: false; reason: "not_found" | "own_request" }
  | { ok: true };

@Injectable()
export class ReimbursementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automation: AutomationService,
  ) {}

  listReimbursements(orgId: string, userId: string, isAdmin: boolean) {
    const conditions = [eq(reimbursements.orgId, orgId)];
    if (!isAdmin) conditions.push(eq(reimbursements.userId, userId));

    return this.db.query.reimbursements.findMany({
      where: and(...conditions),
      with: { user: true },
      orderBy: [desc(reimbursements.createdAt)],
    });
  }

  async createReimbursement(orgId: string, userId: string, body: CreateReimbursementInput) {
    const [record] = await this.db
      .insert(reimbursements)
      .values({
        orgId,
        userId,
        category: body.category,
        amount: body.amount.toString(),
        description: body.description,
        receiptUrl: body.receiptUrl || undefined,
        status: "PENDING",
      })
      .returning();
    return record;
  }

  async updateStatus(
    orgId: string,
    userId: string,
    reimbursementId: number,
    body: PatchReimbursementInput,
  ): Promise<UpdateReimbursementResult> {
    const existing = await this.db.query.reimbursements.findFirst({
      where: and(eq(reimbursements.id, reimbursementId), eq(reimbursements.orgId, orgId)),
    });
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.userId === userId) return { ok: false, reason: "own_request" };

    await this.db
      .update(reimbursements)
      .set({
        status: body.status,
        ...(body.status === "APPROVED" && { approvedBy: userId, approvedAt: new Date() }),
        ...(body.status === "PAID" && { paidAt: new Date() }),
        ...(body.rejectionReason && { rejectionReason: body.rejectionReason }),
        updatedAt: new Date(),
      })
      .where(eq(reimbursements.id, reimbursementId));

    if (body.status === "APPROVED" || body.status === "REJECTED") {
      void this.dispatchAutomation(orgId, reimbursementId, existing.userId, existing.amount, body.status);
    }

    return { ok: true };
  }

  private async dispatchAutomation(
    orgId: string,
    reimbursementId: number,
    employeeId: string,
    amount: string,
    status: "APPROVED" | "REJECTED",
  ): Promise<void> {
    const employee = await this.db.query.users.findFirst({
      where: eq(users.id, employeeId),
      columns: { name: true, email: true },
    });
    await this.automation.runAutomationsForEvent(
      orgId,
      status === "APPROVED" ? "reimbursement.approved" : "reimbursement.rejected",
      {
        reimbursementId,
        userId: employeeId,
        employeeName: employee?.name ?? "",
        employeeEmail: employee?.email ?? "",
        amount: String(amount ?? ""),
        decision: status,
      },
    );
  }
}
