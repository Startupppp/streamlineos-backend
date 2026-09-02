import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../../common/pagination/keyset";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrRetentionPolicies, hrDataRequests } from "../../../../db/schema/hr/governance";
import { users, organizationMembers } from "../../../../db/schema/common/auth";
import { organizationLegalHolds } from "../../../../db/schema/common/organization-purge";
import { HrAuditService } from "../../core/hr-audit.service";
import { isUnderLegalHold, subjectsUnderLegalHold } from "../legal-holds/legal-hold-check.helper";
import { logger } from "../../../../common/logger/logger.service";
import type {
  CreateRetentionPolicyInput,
  UpdateRetentionPolicyInput,
  ListRetentionPoliciesInput,
  CreateDataRequestInput,
  UpdateDataRequestInput,
  ListDataRequestsInput,
} from "./retention.dto";

@Injectable()
export class RetentionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async listPolicies(orgId: string, input: ListRetentionPoliciesInput) {
    const { cursor, limit, recordType, active } = input;
    const pos = decodeCursor(cursor);

    const conditions = [eq(hrRetentionPolicies.orgId, orgId)];
    if (recordType) conditions.push(eq(hrRetentionPolicies.recordType, recordType));
    if (active !== undefined) conditions.push(eq(hrRetentionPolicies.active, active));
    if (pos) conditions.push(keysetBeforeId(hrRetentionPolicies.createdAt, hrRetentionPolicies.id, pos));

    const rows = await this.db
      .select()
      .from(hrRetentionPolicies)
      .where(and(...conditions))
      .orderBy(desc(hrRetentionPolicies.createdAt), desc(hrRetentionPolicies.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async createPolicy(orgId: string, userId: string, input: CreateRetentionPolicyInput, ipAddress?: string) {
    const [policy] = await this.db
      .insert(hrRetentionPolicies)
      .values({
        orgId,
        recordType: input.recordType,
        retentionMonths: input.retentionMonths,
        countryCode: input.countryCode ?? null,
        action: input.action,
        active: input.active ?? true,
      })
      .returning()
      .catch((e: { code?: string }) => {
        if (e.code === "23505")
          throw new ConflictException(
            "A retention policy for this record type and country already exists.",
          );
        throw e;
      });

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_retention_policy",
      entityId: String(policy!.id),
      action: "retention_policy.created",
      after: input,
      ipAddress,
    });

    return policy!;
  }

  async updatePolicy(orgId: string, policyId: number, userId: string, input: UpdateRetentionPolicyInput, ipAddress?: string) {
    const [existing] = await this.db
      .select()
      .from(hrRetentionPolicies)
      .where(and(eq(hrRetentionPolicies.orgId, orgId), eq(hrRetentionPolicies.id, policyId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Retention policy not found");

    const [updated] = await this.db
      .update(hrRetentionPolicies)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(hrRetentionPolicies.orgId, orgId), eq(hrRetentionPolicies.id, policyId)))
      .returning()
      .catch((e: { code?: string }) => {
        if (e.code === "23505")
          throw new ConflictException(
            "A retention policy for this record type and country already exists.",
          );
        throw e;
      });

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_retention_policy",
      entityId: String(policyId),
      action: "retention_policy.updated",
      before: { retentionMonths: existing.retentionMonths, action: existing.action },
      after: input,
      ipAddress,
    });

    return updated!;
  }

  async deletePolicy(orgId: string, policyId: number, userId: string, ipAddress?: string) {
    const [existing] = await this.db
      .select()
      .from(hrRetentionPolicies)
      .where(and(eq(hrRetentionPolicies.orgId, orgId), eq(hrRetentionPolicies.id, policyId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Retention policy not found");

    await this.db
      .delete(hrRetentionPolicies)
      .where(and(eq(hrRetentionPolicies.orgId, orgId), eq(hrRetentionPolicies.id, policyId)));

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_retention_policy",
      entityId: String(policyId),
      action: "retention_policy.deleted",
      ipAddress,
    });
  }

  async listRequests(orgId: string, input: ListDataRequestsInput) {
    const { cursor, limit, status, type, subjectUserId } = input;
    const pos = decodeCursor(cursor);

    const conditions = [eq(hrDataRequests.orgId, orgId), isNull(hrDataRequests.deletedAt)];
    if (status) conditions.push(eq(hrDataRequests.status, status));
    if (type) conditions.push(eq(hrDataRequests.type, type));
    if (subjectUserId) conditions.push(eq(hrDataRequests.subjectUserId, subjectUserId));
    if (pos) conditions.push(keysetBeforeId(hrDataRequests.createdAt, hrDataRequests.id, pos));

    const rows = await this.db
      .select()
      .from(hrDataRequests)
      .where(and(...conditions))
      .orderBy(desc(hrDataRequests.createdAt), desc(hrDataRequests.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async createRequest(orgId: string, userId: string, input: CreateDataRequestInput, ipAddress?: string) {
    if (input.type === "correction" && !input.reason?.trim()) {
      throw new BadRequestException("A correction request must describe the field and corrected value");
    }
    await this.assertSubjectInOrg(orgId, input.subjectUserId);
    const [req] = await this.db
      .insert(hrDataRequests)
      .values({
        orgId,
        subjectUserId: input.subjectUserId,
        type: input.type,
        status: "pending",
        requestedBy: userId,
        reason: input.reason ?? null,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_data_request",
      entityId: String(req!.id),
      action: "data_request.created",
      after: { type: input.type, subjectUserId: input.subjectUserId },
      ipAddress,
    });

    return req!;
  }

  async updateRequest(orgId: string, requestId: number, userId: string, input: UpdateDataRequestInput, ipAddress?: string) {
    const existing = await this.getRequestById(orgId, requestId);

    if (!["pending"].includes(existing.status)) {
      throw new BadRequestException("Only pending requests can be updated");
    }

    const [updated] = await this.db
      .update(hrDataRequests)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(hrDataRequests.orgId, orgId), eq(hrDataRequests.id, requestId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_data_request",
      entityId: String(requestId),
      action: "data_request.updated",
      after: input,
      ipAddress,
    });

    return updated!;
  }

  async approveRequest(orgId: string, requestId: number, userId: string, ipAddress?: string) {
    const existing = await this.getRequestById(orgId, requestId);

    if (existing.status !== "pending") {
      throw new BadRequestException("Only pending requests can be approved");
    }

    const [updated] = await this.db
      .update(hrDataRequests)
      .set({ status: "approved", approvedBy: userId, updatedAt: new Date() })
      .where(and(eq(hrDataRequests.orgId, orgId), eq(hrDataRequests.id, requestId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_data_request",
      entityId: String(requestId),
      action: "data_request.approved",
      before: { status: "pending" },
      after: { status: "approved", approvedBy: userId },
      ipAddress,
    });

    return updated!;
  }

  async processRequest(orgId: string, requestId: number, userId: string, ipAddress?: string) {
    const existing = await this.getRequestById(orgId, requestId);

    if (existing.status !== "approved") {
      throw new BadRequestException("Request must be approved before processing");
    }

    await this.assertSubjectInOrg(orgId, existing.subjectUserId);

    // A correction request is only a validated intake record today. Never mark
    // it processing/completed without an implementation that applies and
    // verifies the requested field-level change.
    if (existing.type === "correction") {
      await this.audit.log({
        orgId,
        actorId: userId,
        entityType: "hr_data_request",
        entityId: String(requestId),
        action: "data_request.correction_manual_review_required",
        after: { type: existing.type, subjectUserId: existing.subjectUserId },
        ipAddress,
      });
      throw new ConflictException(
        "Correction requests require verified field-level processing before completion",
      );
    }

    if (existing.type !== "export") {
      const hrHeld = await isUnderLegalHold(orgId, existing.subjectUserId, this.db);
      const orgHeld = await this.isOrgUnderLegalHold(orgId);
      if (hrHeld || orgHeld) {
        throw new ForbiddenException(
          "Subject is under an active legal hold. Deletion and anonymization are blocked until the hold is released.",
        );
      }
    }

    await this.db
      .update(hrDataRequests)
      .set({ status: "processing", updatedAt: new Date() })
      .where(and(eq(hrDataRequests.orgId, orgId), eq(hrDataRequests.id, requestId)));

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_data_request",
      entityId: String(requestId),
      action: "data_request.processing_started",
      after: { type: existing.type, subjectUserId: existing.subjectUserId },
      ipAddress,
    });

    let result: Record<string, unknown> = {};

    if (existing.type === "export") {
      result = await this.exportSubjectData(orgId, existing.subjectUserId);
    } else if (existing.type === "anonymize") {
      await this.anonymizeSubject(orgId, existing.subjectUserId);
      result = { anonymized: true };
    } else if (existing.type === "delete") {
      await this.anonymizeSubject(orgId, existing.subjectUserId);
      result = { anonymized: true, subjectUserId: existing.subjectUserId };
    }

    await this.db
      .update(hrDataRequests)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(hrDataRequests.orgId, orgId), eq(hrDataRequests.id, requestId)));

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_data_request",
      entityId: String(requestId),
      action: "data_request.completed",
      after: { type: existing.type, subjectUserId: existing.subjectUserId },
      ipAddress,
    });

    return result;
  }

  async sweepStrandedDeleteRequests(orgId: string): Promise<{ processed: number; skipped: number }> {
    const stranded = await this.db
      .select()
      .from(hrDataRequests)
      .where(
        and(
          eq(hrDataRequests.orgId, orgId),
          eq(hrDataRequests.status, "processing"),
          eq(hrDataRequests.type, "delete"),
          isNull(hrDataRequests.deletedAt),
        ),
      )
      .limit(50);

    let processed = 0;
    let skipped = 0;

    /* Loop-invariant: the organisation-wide hold is a property of the org, not of
     * the request, so it was being asked once per stranded request. */
    const orgHeld = await this.isOrgUnderLegalHold(orgId);

    /* The per-subject hold probe is the same shape for every stranded request, so it
     * is one indexed multi-key read rather than one round trip per subject. */
    const heldSubjects = orgHeld
      ? new Set<string>()
      : await subjectsUnderLegalHold(
          orgId,
          stranded.map((req) => req.subjectUserId),
          this.db,
        );

    for (const req of stranded) {
      const hrHeld = orgHeld ? false : heldSubjects.has(req.subjectUserId);
      if (hrHeld || orgHeld) {
        skipped++;
        logger.warn("[retention-sweep] stranded delete request blocked by legal hold", {
          orgId,
          requestId: req.id,
          subjectUserId: req.subjectUserId,
        });
        continue;
      }

      try {
        await this.anonymizeSubject(orgId, req.subjectUserId);
        await this.db
          .update(hrDataRequests)
          .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(hrDataRequests.orgId, orgId), eq(hrDataRequests.id, req.id)));
        processed++;
      } catch (err) {
        skipped++;
        logger.error("[retention-sweep] failed to process stranded delete request", {
          orgId,
          requestId: req.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { processed, skipped };
  }

  private async isOrgUnderLegalHold(orgId: string): Promise<boolean> {
    const [hold] = await this.db
      .select({ holdId: organizationLegalHolds.holdId })
      .from(organizationLegalHolds)
      .where(
        and(
          eq(organizationLegalHolds.orgId, orgId),
          isNull(organizationLegalHolds.releasedAt),
        ),
      )
      .limit(1);
    return hold !== undefined;
  }

  private async getRequestById(orgId: string, requestId: number) {
    const [row] = await this.db
      .select()
      .from(hrDataRequests)
      .where(and(eq(hrDataRequests.orgId, orgId), eq(hrDataRequests.id, requestId), isNull(hrDataRequests.deletedAt)))
      .limit(1);

    if (!row) throw new NotFoundException("Data request not found");
    return row;
  }

  private async assertSubjectInOrg(orgId: string, subjectUserId: string): Promise<void> {
    const [member] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, subjectUserId)))
      .limit(1);
    if (!member) throw new NotFoundException("Subject is not a member of this organization");
  }

  private async exportSubjectData(orgId: string, subjectUserId: string): Promise<Record<string, unknown>> {
    await this.assertSubjectInOrg(orgId, subjectUserId);
    const [profile] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, subjectUserId))
      .limit(1);
    return { exportedAt: new Date().toISOString(), subjectUserId, orgId, profile: profile ?? {} };
  }

  private async anonymizeSubject(orgId: string, subjectUserId: string): Promise<void> {
    await this.assertSubjectInOrg(orgId, subjectUserId);
    const [{ value: memberships }] = await this.db
      .select({ value: count() })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, subjectUserId));
    if (Number(memberships) > 1) {
      throw new BadRequestException(
        "Subject belongs to multiple organizations; remove them from this organization before anonymizing the shared identity.",
      );
    }
    await this.db
      .update(users)
      .set({ name: "Anonymized User", email: `anonymized_${subjectUserId}@removed.invalid` })
      .where(eq(users.id, subjectUserId));
  }
}
