import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrInsuranceClaims,
  hrLoanRepayments,
  hrBenefitPlans,
} from "../../../db/schema/hr/benefits";
import { auditLogs, users } from "../../../db/schema";
import type { SubmitClaimInput, ReviewClaimInput, ClaimsQuery } from "./dto/benefits.schemas";

@Injectable()
export class HrBenefitsClaimsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listClaims(orgId: string, query: ClaimsQuery, requesterId: string, isAdmin: boolean) {
    const { cursor, limit, status, userId } = query;
    const pos = decodeCursor(cursor);

    const conditions = [eq(hrInsuranceClaims.orgId, orgId)];
    if (status) conditions.push(eq(hrInsuranceClaims.status, status));
    if (!isAdmin) {
      conditions.push(eq(hrInsuranceClaims.userId, requesterId));
    } else if (userId) {
      conditions.push(eq(hrInsuranceClaims.userId, userId));
    }
    if (pos) conditions.push(keysetBeforeId(hrInsuranceClaims.submittedAt, hrInsuranceClaims.id, pos));

    const rows = await this.db
      .select({
        claim: hrInsuranceClaims,
        user: {
          id: users.id,
          name: users.name,
          email: users.email,
        },
        plan: hrBenefitPlans,
      })
      .from(hrInsuranceClaims)
      .leftJoin(users, eq(users.id, hrInsuranceClaims.userId))
      .leftJoin(hrBenefitPlans, eq(hrBenefitPlans.id, hrInsuranceClaims.planId))
      .where(and(...conditions))
      .orderBy(desc(hrInsuranceClaims.submittedAt), desc(hrInsuranceClaims.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.claim.submittedAt.toISOString(),
      id: String(row.claim.id),
    }));

    return {
      data: page.data.map((r) => ({ ...r.claim, user: r.user, plan: r.plan })),
      pagination: page.pagination,
    };
  }

  async submitClaim(orgId: string, userId: string, data: SubmitClaimInput) {
    try {
      const [claim] = await this.db
        .insert(hrInsuranceClaims)
        .values({
          orgId,
          userId,
          planId: data.planId,
          claimNumber: data.claimNumber,
          amountCents: data.amountCents,
          status: "submitted",
          documents: data.documents ?? null,
        })
        .returning();
      return claim;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("A claim with this claim number already exists");
      }
      throw err;
    }
  }

  async reviewClaim(orgId: string, claimId: number, reviewerId: string, data: ReviewClaimInput) {
    const [existing] = await this.db
      .select()
      .from(hrInsuranceClaims)
      .where(and(eq(hrInsuranceClaims.id, claimId), eq(hrInsuranceClaims.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Claim not found");

    const newStatus =
      data.status === "approved"
        ? "approved"
        : data.status === "rejected"
          ? "rejected"
          : "in_review";

    await this.db.transaction(async (tx) => {
      await tx
        .update(hrInsuranceClaims)
        .set({
          status: newStatus,
          decidedAt: newStatus !== "in_review" ? new Date() : null,
          decidedBy: newStatus !== "in_review" ? reviewerId : null,
          rejectionReason: data.rejectionReason ?? null,
          payoutRoute: data.payoutRoute ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(hrInsuranceClaims.id, claimId), eq(hrInsuranceClaims.orgId, orgId)));

      await tx.insert(auditLogs).values({
        action: "insurance_claim.reviewed",
        userId: reviewerId,
        orgId,
        actorUserId: reviewerId,
        resourceType: "hr_insurance_claim",
        resourceId: String(claimId),
        metadata: { status: newStatus, payoutRoute: data.payoutRoute ?? null },
      });
    });

    const [result] = await this.db
      .select({
        claim: hrInsuranceClaims,
        user: { id: users.id, name: users.name, email: users.email },
        plan: hrBenefitPlans,
      })
      .from(hrInsuranceClaims)
      .leftJoin(users, eq(users.id, hrInsuranceClaims.userId))
      .leftJoin(hrBenefitPlans, eq(hrBenefitPlans.id, hrInsuranceClaims.planId))
      .where(eq(hrInsuranceClaims.id, claimId))
      .limit(1);

    if (!result) return undefined;
    return { ...result.claim, user: result.user, plan: result.plan };
  }

  async setPayoutRoute(orgId: string, claimId: number, payoutRoute: "payroll_payable" | "finance_payable" | "already_paid") {
    const [existing] = await this.db
      .select()
      .from(hrInsuranceClaims)
      .where(and(eq(hrInsuranceClaims.id, claimId), eq(hrInsuranceClaims.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Claim not found");

    const [updated] = await this.db
      .update(hrInsuranceClaims)
      .set({ payoutRoute, updatedAt: new Date() })
      .where(and(eq(hrInsuranceClaims.id, claimId), eq(hrInsuranceClaims.orgId, orgId)))
      .returning();
    return updated;
  }

  async getPayrollPayableClaims(orgId: string, periodStart: Date, periodEnd: Date) {
    return this.db
      .select()
      .from(hrInsuranceClaims)
      .where(
        and(
          eq(hrInsuranceClaims.orgId, orgId),
          eq(hrInsuranceClaims.status, "approved"),
          eq(hrInsuranceClaims.payoutRoute, "payroll_payable"),
          gte(hrInsuranceClaims.decidedAt, periodStart),
          lte(hrInsuranceClaims.decidedAt, periodEnd),
        ),
      )
      .orderBy(hrInsuranceClaims.decidedAt)
      .limit(2000);
  }

  async getDueLoanRepayments(orgId: string, periodStart: Date, periodEnd: Date) {
    const start = periodStart.toISOString().split("T")[0]!;
    const end = periodEnd.toISOString().split("T")[0]!;

    return this.db
      .select()
      .from(hrLoanRepayments)
      .where(
        and(
          eq(hrLoanRepayments.orgId, orgId),
          eq(hrLoanRepayments.status, "pending"),
          gte(hrLoanRepayments.dueDate, start),
          lte(hrLoanRepayments.dueDate, end),
        ),
      )
      .orderBy(hrLoanRepayments.dueDate)
      .limit(2000);
  }
}
