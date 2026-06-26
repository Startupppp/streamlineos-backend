import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { terminations, users, organizations, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { formatDdMmmYyyy } from "./date.helpers";
import { generateTerminationLetterHtml } from "./letters";
import type { TerminationCreateInput, TerminationReviewInput } from "./dto/hr-lifecycle.schemas";

@Injectable()
export class TerminationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(orgId: string) {
    return this.db
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
        ceoRemarks: terminations.ceoRemarks,
        ceoReviewedBy: terminations.ceoReviewedBy,
        ceoReviewedAt: terminations.ceoReviewedAt,
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
      .where(eq(terminations.orgId, orgId))
      .orderBy(desc(terminations.createdAt));
  }

  async create(orgId: string, actorUserId: string, actorRole: string, input: TerminationCreateInput) {
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

    if (membership.role === "CEO" || membership.isOwner) {
      throw new BadRequestException("CEO cannot be terminated through this workflow.");
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
          : existingActive.status === "PENDING_CEO"
            ? "pending CEO review"
            : existingActive.status === "APPROVED"
              ? "approved"
              : existingActive.status === "SENT"
                ? "in progress (email sent)"
                : "in draft";
      throw new ConflictException(
        `This employee already has an active termination record (${statusLabel}). Only one active termination is allowed at a time.`,
      );
    }

    const isCeoInitiator = actorRole === "CEO";
    const now = new Date();
    const [record] = await this.db
      .insert(terminations)
      .values({
        orgId,
        userId: input.userId,
        reasons: input.reasons,
        detailedExplanation: input.detailedExplanation,
        effectiveDate: input.effectiveDate,
        severanceAmount: input.severanceAmount !== undefined ? input.severanceAmount.toString() : undefined,
        noticePeriodWaived: input.noticePeriodWaived,
        internalNotes: input.internalNotes,
        status: isCeoInitiator ? "APPROVED" : "DRAFT",
        initiatedBy: actorUserId,
        ...(isCeoInitiator && { ceoReviewedBy: actorUserId, ceoReviewedAt: now }),
      })
      .returning();

    this.audit.log({
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
      with: { user: true, initiator: true, ceoReviewer: true },
    });
    if (!data) throw new NotFoundException("Termination not found.");
    return data;
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

    await this.db
      .update(terminations)
      .set({
        status: "PENDING_CEO",
        ceoRemarks: null,
        ceoReviewedBy: null,
        ceoReviewedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(terminations.id, terminationId));

    this.audit.log({
      action: "TERMINATION_SUBMITTED",
      userId: actorUserId,
      orgId,
      targetId: String(terminationId),
      targetType: "termination",
      metadata: { from: previousStatus, to: "PENDING_CEO", employeeId: existing.userId },
    });

    return { success: true };
  }

  async ceoReview(orgId: string, actorUserId: string, terminationId: number, input: TerminationReviewInput) {
    const existing = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Termination not found.");
    if (existing.status !== "PENDING_CEO") throw new BadRequestException("Termination is not pending CEO review.");

    if (input.decision === "reject" && !input.remarks) {
      throw new BadRequestException("Remarks are required when rejecting.");
    }

    const newStatus = input.decision === "approve" ? "APPROVED" : "REJECTED";

    await this.db
      .update(terminations)
      .set({
        status: newStatus,
        ceoReviewedBy: actorUserId,
        ceoReviewedAt: new Date(),
        ceoRemarks: input.remarks || null,
        updatedAt: new Date(),
      })
      .where(eq(terminations.id, terminationId));

    this.audit.log({
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
    const termination = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
      with: { user: true },
    });
    if (!termination) throw new NotFoundException("Termination not found.");

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });

    const employee = termination.user;
    const letterHtml = generateTerminationLetterHtml({
      employeeName: employee?.name ?? "Employee",
      designation: employee?.designation ?? "N/A",
      companyName: org?.name ?? "the Company",
      reasons: termination.reasons ?? [],
      effectiveDate: termination.effectiveDate ? formatDdMmmYyyy(termination.effectiveDate) : "N/A",
      severanceAmount: termination.severanceAmount,
      date: formatDdMmmYyyy(new Date()),
    });

    return { html: letterHtml };
  }
}
