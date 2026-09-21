import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { fnfSettlements, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateFnfInput } from "./dto/payroll.schemas";
import { buildListResponse } from "../../../common/pagination/pagination";

type FnfRow = typeof fnfSettlements.$inferSelect;
type FnfStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "HR_REVIEW"
  | "FINANCE_REVIEW"
  | "APPROVED"
  | "PAID";

export type CreateFnfResult = { ok: false } | { ok: true; record: FnfRow };
export type UpdateFnfResult = { ok: false } | { ok: true; record: FnfRow };

type UpdateFnfBody = {
  status: FnfStatus;
  notes?: string | null;
};

type ExtendedCreateFnfInput = CreateFnfInput & {
  reimbursementsDue?: number;
  assetRecovery?: number;
  noticeRecovery?: number;
  otherDeductions?: number;
};

const VALID_FNF_TRANSITIONS: Record<FnfStatus, FnfStatus[]> = {
  DRAFT: ["PENDING_APPROVAL"],
  PENDING_APPROVAL: ["HR_REVIEW", "APPROVED"],
  HR_REVIEW: ["FINANCE_REVIEW", "APPROVED"],
  FINANCE_REVIEW: ["APPROVED"],
  APPROVED: ["PAID"],
  PAID: [],
};

@Injectable()
export class FnfService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listFnf(orgId: string, userId: string, membershipId: number | null, isAdmin: boolean, page = 1, limit = 100) {
    if (!isAdmin && membershipId === null) throw new ForbiddenException("Organization membership required");
    const ownPredicate = eq(fnfSettlements.userMembershipId, membershipId ?? 0);
    const where = isAdmin
      ? eq(fnfSettlements.orgId, orgId)
      : and(eq(fnfSettlements.orgId, orgId), ownPredicate);

    const [rows, [totalRow]] = await Promise.all([
      this.db.query.fnfSettlements.findMany({
        where,
        orderBy: [desc(fnfSettlements.createdAt)],
        with: { user: { columns: { name: true, email: true } } },
        limit,
        offset: (page - 1) * limit,
      }),
      this.db.select({ total: count() }).from(fnfSettlements).where(where),
    ]);

    return buildListResponse(rows, Number(totalRow?.total ?? 0), { page, pageSize: limit });
  }

  async createFnf(
    orgId: string,
    body: ExtendedCreateFnfInput,
  ): Promise<CreateFnfResult> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, body.userId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { userId: true, id: true },
    });
    if (!member) return { ok: false };

    const basicDues = body.basicDues ?? 0;
    const leaveEncashment = body.leaveEncashment ?? 0;
    const bonusDue = body.bonusDue ?? 0;
    const reimbursementsDue = body.reimbursementsDue ?? 0;
    const deductions = body.deductions ?? 0;
    const loanRecovery = body.loanRecovery ?? 0;
    const assetRecovery = body.assetRecovery ?? 0;
    const noticeRecovery = body.noticeRecovery ?? 0;
    const otherDeductions = body.otherDeductions ?? 0;
    const netPayable =
      basicDues +
      leaveEncashment +
      bonusDue +
      reimbursementsDue -
      deductions -
      loanRecovery -
      assetRecovery -
      noticeRecovery -
      otherDeductions;

    const [record] = await this.db
      .insert(fnfSettlements)
      .values({
        orgId,
        status: "DRAFT",
        userId: body.userId,
        userMembershipId: member.id,
        notes: body.notes ?? null,
        bonusDue: bonusDue.toString(),
        basicDues: basicDues.toString(),
        deductions: deductions.toString(),
        netPayable: netPayable.toString(),
        loanRecovery: loanRecovery.toString(),
        assetRecovery: assetRecovery.toString(),
        noticeRecovery: noticeRecovery.toString(),
        resignationId: body.resignationId ?? null,
        otherDeductions: otherDeductions.toString(),
        leaveEncashment: leaveEncashment.toString(),
        reimbursementsDue: reimbursementsDue.toString(),
      })
      .returning();

    return { ok: true, record };
  }

  async updateFnf(
    orgId: string,
    userId: string,
    fnfId: number,
    body: UpdateFnfBody,
  ): Promise<UpdateFnfResult> {
    const [existing] = await this.db
      .select({
        status: fnfSettlements.status,
        approvedBy: fnfSettlements.approvedBy,
        notes: fnfSettlements.notes,
      })
      .from(fnfSettlements)
      .where(
        and(eq(fnfSettlements.id, fnfId), eq(fnfSettlements.orgId, orgId)),
      )
      .limit(1);

    if (!existing) return { ok: false };

    const currentStatus: FnfStatus = existing.status;
    const targetStatus = body.status;
    const allowedNext = VALID_FNF_TRANSITIONS[currentStatus] ?? [];
    if (!allowedNext.includes(targetStatus)) {
      throw new ConflictException(
        `Invalid final settlement status transition: ${currentStatus} → ${targetStatus}. Allowed: ${allowedNext.join(", ") || "none"}`,
      );
    }

    const isApprovalStep =
      targetStatus === "APPROVED" || targetStatus === "PAID";

    const [updated] = await this.db
      .update(fnfSettlements)
      .set({
        status: targetStatus,
        approvedBy: isApprovalStep ? userId : existing.approvedBy,
        notes: body.notes ?? existing.notes,
        updatedAt: new Date(),
      })
      .where(and(eq(fnfSettlements.id, fnfId), eq(fnfSettlements.orgId, orgId)))
      .returning();

    return { ok: true, record: updated };
  }
}
