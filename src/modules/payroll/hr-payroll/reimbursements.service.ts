import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { reimbursements, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AutomationService } from "../../automation/automation.service";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import type { CreateReimbursementInput, PatchReimbursementInput } from "./dto/payroll.schemas";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";

export type UpdateReimbursementResult =
  | { ok: false; reason: "not_found" | "own_request" }
  | { ok: true };

@Injectable()
export class ReimbursementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automation: AutomationService,
  ) {}

  listReimbursements(orgId: string, userId: string, membershipId: number | null, scope: DataScope, page = 1, limit = 100) {
    const ownerPredicate = scope === "own" && membershipId != null
      ? eq(reimbursements.userMembershipId, membershipId)
      : applyScope(scope, orgId, userId, { ownerColumn: reimbursements.userId });
    const conditions = [eq(reimbursements.orgId, orgId), ownerPredicate];

    return this.db.query.reimbursements.findMany({
      where: and(...conditions),
      with: {
        user: {
          columns: { id: true, name: true, firstName: true, lastName: true, email: true, image: true },
        },
      },
      orderBy: [desc(reimbursements.createdAt)],
      limit,
      offset: (page - 1) * limit,
    });
  }

  async createReimbursement(orgId: string, userId: string, membershipId: number | null, body: CreateReimbursementInput) {
    const [record] = await this.db
      .insert(reimbursements)
      .values({
        orgId,
        userId,
        userMembershipId: membershipId ?? undefined,
        category: body.category,
        amount: body.amount.toString(),
        description: body.description,
        receiptUrl: body.receiptUrl || undefined,
        payrollMonth: body.payrollMonth ?? null,
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

    const reimburserActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    await this.db
      .update(reimbursements)
      .set({
        status: body.status,
        ...(body.status === "APPROVED" && { approvedBy: userId, approvedByMembershipId: reimburserActor.membershipId, approvedAt: new Date() }),
        ...(body.status === "PAID" && { paidAt: new Date() }),
        ...(body.rejectionReason && { rejectionReason: body.rejectionReason }),
        updatedAt: new Date(),
      })
      .where(and(eq(reimbursements.id, reimbursementId), eq(reimbursements.orgId, orgId)));

    if (body.status === "APPROVED" || body.status === "REJECTED") {
      const status = body.status;
      const dispatch = () =>
        this.dispatchAutomation(orgId, reimbursementId, existing.userId, existing.amount, status);
      if (!registerAfterCommit(dispatch)) await dispatch();
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
