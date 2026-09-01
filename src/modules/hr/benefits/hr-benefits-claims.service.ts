import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
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
import { auditLogs, organizationMembers, users } from "../../../db/schema";
import type { SubmitClaimInput, ReviewClaimInput, ClaimsQuery } from "./dto/benefits.schemas";
import { boundHrReadLimit } from "../hr-read-limits";

type ClaimsCursorScope = {
  orgId: string;
  requesterMembershipId: number | null;
  isAdmin: boolean;
  status: string | null;
  userId: string | null;
};

function invalidClaimsCursor(): never {
  throw new BadRequestException({
    code: "INVALID_BENEFITS_CLAIMS_CURSOR",
    message: "The benefits claims cursor is invalid or expired.",
  });
}

function decodeClaimsCursor(value: string | undefined, expected: ClaimsCursorScope) {
  if (!value) return null;
  const position = decodeCursor(value);
  if (!position || Number.isNaN(new Date(position.sortValue).getTime()))
    return invalidClaimsCursor();

  try {
    const scope: unknown = JSON.parse(position.id);
    if (
      !Array.isArray(scope) ||
      scope.length !== 6 ||
      typeof scope[0] !== "number" ||
      !Number.isSafeInteger(scope[0]) ||
      scope[0] < 1 ||
      scope[1] !== expected.orgId ||
      scope[2] !== expected.requesterMembershipId ||
      scope[3] !== expected.isAdmin ||
      scope[4] !== expected.status ||
      scope[5] !== expected.userId
    )
      return invalidClaimsCursor();
    return { sortValue: position.sortValue, id: String(scope[0]) };
  } catch {
    return invalidClaimsCursor();
  }
}

@Injectable()
export class HrBenefitsClaimsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listClaims(
    orgId: string,
    query: ClaimsQuery,
    requesterId: string,
    requesterMembershipId: number | null,
    isAdmin: boolean,
  ) {
    if (requesterMembershipId == null) {
      throw new BadRequestException("Organization membership required.");
    }
    const { cursor, status, userId } = query;
    const limit = boundHrReadLimit(query.limit);
    const cursorScope = {
      orgId,
      requesterMembershipId,
      isAdmin,
      status: status ?? null,
      userId: isAdmin ? (userId ?? null) : requesterId,
    };
    const pos = decodeClaimsCursor(cursor, cursorScope);
    const targetMembershipId = isAdmin && userId
      ? await this.resolveMembershipId(orgId, userId)
      : requesterMembershipId;

    const conditions = [eq(hrInsuranceClaims.orgId, orgId)];
    if (status) conditions.push(eq(hrInsuranceClaims.status, status));
    if (!isAdmin) {
      conditions.push(eq(hrInsuranceClaims.userMembershipId, requesterMembershipId));
    } else if (userId) {
      conditions.push(eq(hrInsuranceClaims.userMembershipId, targetMembershipId));
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
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, hrInsuranceClaims.orgId),
          eq(organizationMembers.id, hrInsuranceClaims.userMembershipId),
        ),
      )
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(hrBenefitPlans, eq(hrBenefitPlans.id, hrInsuranceClaims.planId))
      .where(and(...conditions))
      .orderBy(desc(hrInsuranceClaims.submittedAt), desc(hrInsuranceClaims.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.claim.submittedAt.toISOString(),
      id: JSON.stringify([
        row.claim.id,
        cursorScope.orgId,
        cursorScope.requesterMembershipId,
        cursorScope.isAdmin,
        cursorScope.status,
        cursorScope.userId,
      ]),
    }));

    return {
      data: page.data.map((r) => ({ ...r.claim, user: r.user, plan: r.plan })),
      pagination: page.pagination,
    };
  }

  async submitClaim(orgId: string, userId: string, membershipId: number | null, data: SubmitClaimInput) {
    if (membershipId == null) throw new BadRequestException("Organization membership required.");
    try {
      const [claim] = await this.db
        .insert(hrInsuranceClaims)
        .values({
          orgId,
          userId,
          userMembershipId: membershipId,
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

  async reviewClaim(
    orgId: string,
    claimId: number,
    reviewerId: string,
    reviewerMembershipId: number | null,
    data: ReviewClaimInput,
  ) {
    if (reviewerMembershipId == null) throw new BadRequestException("Organization membership required.");
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
          decidedByMembershipId: newStatus !== "in_review" ? reviewerMembershipId : null,
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
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, hrInsuranceClaims.orgId),
          eq(organizationMembers.id, hrInsuranceClaims.userMembershipId),
        ),
      )
      .innerJoin(users, eq(users.id, organizationMembers.userId))
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

  private async resolveMembershipId(orgId: string, userId: string): Promise<number> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { id: true },
    });
    if (!member) throw new NotFoundException("Claim subject is not a member of this organization");
    return member.id;
  }
}
