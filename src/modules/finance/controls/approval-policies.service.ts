import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { finApprovalPolicies, organizationMembers } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import type {
  CreateApprovalPolicyInput,
  UpdateApprovalPolicyInput,
} from "./dto/finance-controls.schemas";

@Injectable()
export class ApprovalPoliciesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, cursor?: string, limit = 20): Promise<CursorPage<typeof finApprovalPolicies.$inferSelect>> {
    const pos = decodeCursor(cursor);
    const conditions = [eq(finApprovalPolicies.orgId, orgId)];
    if (pos) conditions.push(keysetBeforeId(finApprovalPolicies.createdAt, finApprovalPolicies.id, pos));

    const rows = await this.db
      .select()
      .from(finApprovalPolicies)
      .where(and(...conditions))
      .orderBy(desc(finApprovalPolicies.createdAt), desc(finApprovalPolicies.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
  }

  async create(orgId: string, userId: string, input: CreateApprovalPolicyInput) {
    let approverMembershipId: number | null = null;
    if (input.approverUserId) {
      approverMembershipId = await this.assertOrgMember(orgId, input.approverUserId);
    }

    const [policy] = await this.db
      .insert(finApprovalPolicies)
      .values({
        orgId,
        recordType: input.recordType,
        minAmount: input.minAmount ?? null,
        approverRole: input.approverRole ?? null,
        approverUserId: input.approverUserId ?? null,
        approverMembershipId,
        isActive: input.isActive ?? true,
      })
      .returning();

    if (!policy) throw new Error("Approval policy insert returned no rows");

    this.audit.log({
      action: "accounting.approval_policy.create",
      userId,
      orgId,
      resourceType: "approval_policy",
      resourceId: String(policy.id),
      result: "SUCCESS",
    });

    return policy;
  }

  async update(orgId: string, userId: string, policyId: number, input: UpdateApprovalPolicyInput) {
    const existing = await this.findOrFail(orgId, policyId);

    let approverMembershipId: number | null | undefined;
    if (input.approverUserId !== undefined) {
      if (input.approverUserId && input.approverUserId !== existing.approverUserId) {
        approverMembershipId = await this.assertOrgMember(orgId, input.approverUserId);
      } else if (!input.approverUserId) {
        approverMembershipId = null;
      }
    }

    const [updated] = await this.db
      .update(finApprovalPolicies)
      .set({
        ...(input.recordType !== undefined ? { recordType: input.recordType } : {}),
        ...(input.minAmount !== undefined ? { minAmount: input.minAmount } : {}),
        ...(input.approverRole !== undefined ? { approverRole: input.approverRole } : {}),
        ...(input.approverUserId !== undefined ? { approverUserId: input.approverUserId } : {}),
        ...(approverMembershipId !== undefined ? { approverMembershipId } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      })
      .where(and(eq(finApprovalPolicies.id, policyId), eq(finApprovalPolicies.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Approval policy not found");

    this.audit.log({
      action: "accounting.approval_policy.update",
      userId,
      orgId,
      resourceType: "approval_policy",
      resourceId: String(policyId),
      result: "SUCCESS",
    });

    return updated;
  }

  async remove(orgId: string, userId: string, policyId: number) {
    await this.findOrFail(orgId, policyId);

    await this.db
      .update(finApprovalPolicies)
      .set({ isActive: false })
      .where(and(eq(finApprovalPolicies.id, policyId), eq(finApprovalPolicies.orgId, orgId)));

    this.audit.log({
      action: "accounting.approval_policy.delete",
      userId,
      orgId,
      resourceType: "approval_policy",
      resourceId: String(policyId),
      result: "SUCCESS",
    });

    return { deleted: true };
  }

  private async findOrFail(orgId: string, policyId: number) {
    const rows = await this.db
      .select()
      .from(finApprovalPolicies)
      .where(and(eq(finApprovalPolicies.id, policyId), eq(finApprovalPolicies.orgId, orgId)))
      .limit(1);

    if (!rows[0]) throw new NotFoundException("Approval policy not found");
    return rows[0];
  }

  private async assertOrgMember(orgId: string, userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!rows[0]) {
      throw new ForbiddenException("Approver user is not a member of this organization");
    }
    return rows[0].id;
  }

  async assertPolicyMinAmountValid(input: CreateApprovalPolicyInput) {
    if (input.minAmount !== null && input.minAmount !== undefined) {
      const parsed = Number(input.minAmount);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new BadRequestException("minAmount must be a non-negative number");
      }
    }
  }
}
