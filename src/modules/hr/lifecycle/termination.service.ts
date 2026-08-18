import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, lte, notInArray, sql } from "drizzle-orm";
import {
  terminations,
  users,
  organizationMembers,
  moduleOwnerships,
  roleAssignments,
  roles,
  fnfSettlements,
  assetReturns,
  assets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ROLE_RANK } from "../../../common/rbac/grantability";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AutomationService } from "../../automation/automation.service";
import { HrAutomationEngineService } from "../automations/hr-automation-engine.service";
import { OrgMembershipService } from "../../organization/core/org-membership.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type {
  TerminationCreateInput,
  TerminationReviewInput,
  ListTerminationsQueryInput,
} from "./dto/hr-lifecycle.schemas";
import { TerminationCommunicationsService } from "./termination-communications.service";
import { resolveCompatibleList } from "../../../common/db/expand-contract-compat";
import {
  loadTerminationRelationalCollections,
  syncTerminationReasons,
} from "./termination-relational-compat";
import { transitionTermination } from "./lifecycle-transition";

@Injectable()
export class TerminationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly communications: TerminationCommunicationsService,
    private readonly automation: AutomationService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly memberships: OrgMembershipService,
  ) {}
  async list(orgId: string, params: ListTerminationsQueryInput) {
    const limit = Math.min(params.limit, 100);
    const offset = (params.page - 1) * limit;
    const conditions = [eq(terminations.orgId, orgId)];
    if (params.status) conditions.push(eq(terminations.status, params.status));
    const where = and(...conditions);
    const [data, statusRows] = await Promise.all([
      this.db
        .select({
          id: terminations.id,
          orgId: terminations.orgId,
          userId: terminations.userId,
          status: terminations.status,
          reasons: terminations.reasons,
          detailedExplanation: terminations.detailedExplanation,
          effectiveDate: terminations.effectiveDate,
          severanceAmount: terminations.severanceAmount,
          noticePeriodWaived: terminations.noticePeriodWaived,
          internalNotes: terminations.internalNotes,
          createdAt: terminations.createdAt,
          updatedAt: terminations.updatedAt,
          finalRemarks: terminations.finalRemarks,
          finalReviewedBy: terminations.finalReviewedBy,
          finalReviewedAt: terminations.finalReviewedAt,
          emailSentAt: terminations.emailSentAt,
          emailStatus: terminations.emailStatus,
          initiatedBy: terminations.initiatedBy,
          employee: {
            id: users.id,
            name: users.name,
            email: users.email,
            designation: users.designation,
            employeeId: users.employeeId,
          },
        })
        .from(terminations)
        .leftJoin(users, eq(terminations.userId, users.id))
        .where(where)
        .orderBy(desc(terminations.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ status: terminations.status, count: sql<number>`count(*)` })
        .from(terminations)
        .where(eq(terminations.orgId, orgId))
      .groupBy(terminations.status),
    ]);
    const statusCounts: Record<string, number> = {};
    let orgTotal = 0;
    for (const row of statusRows) {
      const rowCount = Number(row.count ?? 0);
      if (row.status) statusCounts[row.status] = rowCount;
      orgTotal += rowCount;
    }
    const total = params.status ? (statusCounts[params.status] ?? 0) : orgTotal;
    const relationalCollections = await loadTerminationRelationalCollections(
      this.db,
      orgId,
      data.map((termination) => termination.id),
    );
    const compatibleData = data.map((termination) => ({
      ...termination,
      reasons: resolveCompatibleList(
        termination.reasons,
        relationalCollections.reasonsByTerminationId.get(termination.id),
      ),
    }));
    return {
      data: compatibleData,
      pagination: { page: params.page, limit, total, totalPages: Math.ceil(total / limit) },
      statusCounts: { ...statusCounts, ALL: orgTotal },
    };
  }

  async create(orgId: string, actorUserId: string, isOrgAdmin: boolean, input: TerminationCreateInput) {
    if (input.userId === actorUserId) throw new BadRequestException("You cannot terminate yourself.");
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, input.userId), eq(organizationMembers.orgId, orgId)),
    });
    if (!membership) throw new NotFoundException("Employee not found.");
    const targetUser = await this.db.query.users.findFirst({
      where: eq(users.id, input.userId),
      columns: { id: true, isActive: true },
    });
    if (!targetUser) throw new NotFoundException("Employee not found.");
    if (membership.isOwner) {
      throw new BadRequestException(
        "The organization owner cannot be terminated. Transfer organization ownership first.",
      );
    }
    const [ownedModules, privilegedRoles] = await Promise.all([
      this.db
        .select({ moduleKey: moduleOwnerships.moduleKey })
        .from(moduleOwnerships)
        .where(
          and(
            eq(moduleOwnerships.orgId, orgId),
            eq(moduleOwnerships.ownerMembershipId, membership.id),
          ),
        ),
      this.db
        .select({ name: roles.name, rank: roles.rank })
        .from(roleAssignments)
        .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
        .where(
          and(
            eq(roleAssignments.orgId, orgId),
            eq(roleAssignments.organizationMembershipId, membership.id),
            lte(roles.rank, ROLE_RANK.MODULE_ADMIN),
          ),
      ),
    ]);
    if (ownedModules.length > 0) {
      throw new BadRequestException(
        `This employee owns the following module(s): ${ownedModules.map((m) => m.moduleKey).join(", ")}. Transfer module ownership before terminating them.`,
      );
    }

    if (privilegedRoles.length > 0) {
      throw new BadRequestException(
        `This employee holds administrative role(s): ${privilegedRoles.map((r) => r.name).join(", ")}. Remove those roles before terminating them.`,
      );
    }

    if (!targetUser.isActive) {
      throw new BadRequestException("This employee has already been terminated or is inactive.");
    }

    const existingActive = await this.db.query.terminations.findFirst({
      where: and(
        eq(terminations.userId, input.userId),
        eq(terminations.orgId, orgId),
        notInArray(terminations.status, ["REJECTED"]),
      ),
      columns: { id: true, status: true },
    });
    if (existingActive) {
      const statusLabel =
        existingActive.status === "COMPLETED"
          ? "completed"
          : existingActive.status === "PENDING_FINAL"
            ? "pending FINAL review"
            : existingActive.status === "APPROVED"
              ? "approved"
              : existingActive.status === "SENT"
                ? "in progress (email sent)"
                : "in draft";
      throw new ConflictException(
        `This employee already has an active termination record (${statusLabel}). Only one active termination is allowed at a time.`,
      );
    }

    const isOrgAdminInitiator = isOrgAdmin;
    const now = new Date();
    const record = await runInTenantTransaction(
      this.db,
      async (transaction) => {
        const [createdTermination] = await transaction
          .insert(terminations)
          .values({
            orgId,
            userId: input.userId,
            reasons: input.reasons,
            detailedExplanation: input.detailedExplanation,
            effectiveDate: input.effectiveDate,
            severanceAmount:
              input.severanceAmount !== undefined
                ? input.severanceAmount.toString()
                : undefined,
            noticePeriodWaived: input.noticePeriodWaived,
            internalNotes: input.internalNotes,
            status: isOrgAdminInitiator ? "APPROVED" : "DRAFT",
            initiatedBy: actorUserId,
            ...(isOrgAdminInitiator && {
              finalReviewedBy: actorUserId,
              finalReviewedAt: now,
            }),
          })
          .returning();
        if (!createdTermination) throw new Error("Failed to create termination");
        await syncTerminationReasons(
          transaction,
          orgId,
          createdTermination.id,
          input.reasons,
        );
        return createdTermination;
      },
      { orgId },
    );

    await this.audit.logCritical({
      action: "TERMINATION_CREATED",
      userId: actorUserId,
      orgId,
      targetId: String(record.id),
      targetType: "termination",
      metadata: { employeeId: input.userId, reasons: input.reasons },
    });

    return record;
  }

  async getOne(orgId: string, terminationId: number) {
    const data = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
      with: {
        user: { columns: { id: true, name: true, email: true, image: true, designation: true, joiningDate: true } },
        initiator: { columns: { id: true, name: true } },
        finalReviewer: { columns: { id: true, name: true } },
      },
    });
    if (!data) throw new NotFoundException("Termination not found.");
    const relationalCollections = await loadTerminationRelationalCollections(
      this.db,
      orgId,
      [data.id],
    );
    return {
      ...data,
      reasons: resolveCompatibleList(
        data.reasons,
        relationalCollections.reasonsByTerminationId.get(data.id),
      ),
      supportingDocUrls:
        data.supportingDocUrls === null
          ? null
          : resolveCompatibleList(
              data.supportingDocUrls,
              relationalCollections.supportingDocumentsByTerminationId.get(data.id),
            ),
    };
  }

  async submit(orgId: string, actorUserId: string, terminationId: number) {
    const existing = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Termination not found.");
    if (existing.status !== "DRAFT" && existing.status !== "REJECTED") {
      throw new BadRequestException("Only draft or rejected terminations can be submitted.");
    }

    const previousStatus = existing.status;

    await transitionTermination(this.db, {
      organizationId: orgId,
      terminationId,
      currentStatus: existing.status,
      currentVersion: existing.rowVersion,
      changes: {
        status: "PENDING_FINAL",
        finalRemarks: null,
        finalReviewedBy: null,
        finalReviewedAt: null,
      },
    });

    await this.audit.logCritical({
      action: "TERMINATION_SUBMITTED",
      userId: actorUserId,
      orgId,
      targetId: String(terminationId),
      targetType: "termination",
      metadata: { from: previousStatus, to: "PENDING_FINAL", employeeId: existing.userId },
    });

    return { success: true };
  }

  async finalReview(orgId: string, actorUserId: string, terminationId: number, input: TerminationReviewInput) {
    const existing = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Termination not found.");
    if (existing.status !== "PENDING_FINAL") throw new BadRequestException("Termination is not pending FINAL review.");

    if (input.decision === "reject" && !input.remarks) {
      throw new BadRequestException("Remarks are required when rejecting.");
    }

    const newStatus = input.decision === "approve" ? "APPROVED" : "REJECTED";

    await transitionTermination(this.db, {
      organizationId: orgId,
      terminationId,
      currentStatus: existing.status,
      currentVersion: existing.rowVersion,
      changes: {
        status: newStatus,
        finalReviewedBy: actorUserId,
        finalReviewedAt: new Date(),
        finalRemarks: input.remarks || null,
      },
    });

    await this.audit.logCritical({
      action: newStatus === "APPROVED" ? "TERMINATION_APPROVED" : "TERMINATION_REJECTED",
      userId: actorUserId,
      orgId,
      targetId: String(terminationId),
      targetType: "termination",
      metadata: { employeeId: existing.userId, remarks: input.remarks },
    });

    return { success: true };
  }

  async getLetter(orgId: string, terminationId: number) {
    return this.communications.getLetter(orgId, terminationId);
  }

  async sendEmail(orgId: string, actorUserId: string, terminationId: number) {
    return this.communications.sendEmail(orgId, actorUserId, terminationId);
  }

  async complete(orgId: string, actorUserId: string, terminationId: number) {
    const existing = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Termination not found.");
    if (existing.status !== "SENT") throw new BadRequestException("Termination letter must be sent first.");

    const assignedAssets = await runInTenantTransaction(this.db, async (tx) => {
      await transitionTermination(tx, {
        organizationId: orgId,
        terminationId,
        currentStatus: existing.status,
        currentVersion: existing.rowVersion,
        changes: { status: "COMPLETED" },
      });

      await tx
        .insert(fnfSettlements)
        .values({ orgId, userId: existing.userId, status: "DRAFT" })
        .onConflictDoNothing();

      const found = await tx.query.assets.findMany({
        where: and(eq(assets.orgId, orgId), eq(assets.assignedTo, existing.userId), eq(assets.status, "ASSIGNED")),
      });

      if (found.length > 0) {
        await tx.insert(assetReturns).values(
          found.map((asset) => ({
            orgId,
            userId: existing.userId,
            assetId: asset.id,
            assetName: asset.name,
            status: "PENDING",
          })),
        );
      }

      // Employment termination is tenant-scoped. Archive only this
      // organization membership so active memberships in other organizations
      // and the person's global sign-in remain usable.
      await this.memberships.setMemberLifecycleStatus(
        orgId,
        actorUserId,
        existing.userId,
        "archived",
        {
          reason: "Employment terminated",
          auditAction: "org.member_archived_after_termination",
        },
      );

      return found;
    }, { orgId });

    await this.invalidateHrDashboardCache(orgId);

    const relationalCollections = await loadTerminationRelationalCollections(
      this.db,
      orgId,
      [terminationId],
    );
    const compatibleReasons = resolveCompatibleList(
      existing.reasons,
      relationalCollections.reasonsByTerminationId.get(terminationId),
    );

    this.dispatchEmployeeTerminated(
      orgId,
      terminationId,
      existing.userId,
      compatibleReasons,
      existing.noticePeriodWaived ?? false,
    );

    await this.audit.logCritical({
      action: "TERMINATION_COMPLETED",
      userId: actorUserId,
      orgId,
      targetId: String(terminationId),
      targetType: "termination",
      metadata: {
        employeeId: existing.userId,
        organizationMembershipArchived: true,
        globalAccountDeactivated: false,
        fnfInitiated: true,
        assetsToReturn: assignedAssets.length,
      },
    });

    return { success: true };
  }

  private async invalidateHrDashboardCache(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidate(`hr:analytics:${orgId}`),
      this.cache.invalidate(`hr:dashboard:metrics:${orgId}`),
      this.cache.invalidate(`hr:dashboard:headcount-trends:${orgId}`),
      this.cache.invalidate(`hr:celebrations:${orgId}`),
    ]);
  }

  private dispatchEmployeeTerminated(
    orgId: string,
    terminationId: number,
    employeeId: string,
    reasons: string[],
    noticePeriodWaived: boolean,
  ): void {
    void (async () => {
      const employee = await this.db.query.users.findFirst({
        where: eq(users.id, employeeId),
        columns: { name: true },
      });
      const payload = {
        terminationId,
        userId: employeeId,
        employeeName: employee?.name ?? "Employee",
        effectiveDate: new Date().toISOString(),
        reasons,
        noticePeriodWaived,
        exitType: "termination",
      };
      await this.hrAutomation.emit(orgId, "exit.completed", {
        ...payload,
        exitType: "termination",
      });
      await this.automation.runAutomationsForEvent(orgId, "employee.terminated", payload);
    })().catch(() => undefined);
  }
}
