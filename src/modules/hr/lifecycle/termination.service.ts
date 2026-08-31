import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, lte, notInArray } from "drizzle-orm";
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
import { TerminationReadService } from "./termination-read.service";
import { TerminationLifecycleService } from "./termination-lifecycle.service";

@Injectable()
export class TerminationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly communications: TerminationCommunicationsService,
    private readonly memberships: OrgMembershipService,
    private readonly reader: TerminationReadService,
    private readonly lifecycle: TerminationLifecycleService,
  ) {}

  async list(orgId: string, params: ListTerminationsQueryInput) {
    return this.reader.list(orgId, params);
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
    return this.reader.getOne(orgId, terminationId);
  }

  async submit(orgId: string, actorUserId: string, terminationId: number) {
    return this.lifecycle.submit(orgId, actorUserId, terminationId);
  }

  async finalReview(orgId: string, actorUserId: string, terminationId: number, input: TerminationReviewInput) {
    return this.lifecycle.finalReview(orgId, actorUserId, terminationId, input);
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

    await this.lifecycle.invalidateHrDashboardCache(orgId);

    const relationalCollections = await loadTerminationRelationalCollections(
      this.db,
      orgId,
      [terminationId],
    );
    const compatibleReasons = resolveCompatibleList(
      existing.reasons,
      relationalCollections.reasonsByTerminationId.get(terminationId),
    );

    this.lifecycle.dispatchEmployeeTerminated(
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
}
