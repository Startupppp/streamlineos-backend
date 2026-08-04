import { ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { SQL, aliasedTable, and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  documentAuditLogs,
  documentTypes,
  onboardingDocuments,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AutomationService } from "../../automation/automation.service";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import type {
  CreateOnboardingDocInput,
  ListOnboardingDocsQueryInput,
  OnboardingDocsSummaryQueryInput,
  ReviewOnboardingDocInput,
} from "./dto/hr-lifecycle.schemas";

const reviewerUsers = aliasedTable(users, "reviewer");

@Injectable()
export class OnboardingViewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automation: AutomationService,
  ) {}

  async summary(orgId: string, query: OnboardingDocsSummaryQueryInput, scope: DataScope, actorUserId: string) {
    const conditions: SQL[] = [
      eq(users.isActive, true),
      applyScope(scope, orgId, actorUserId, { ownerColumn: users.id }),
    ];
    if (query.status) conditions.push(eq(users.onboardingDocStatus, query.status));
    if (query.search) {
      const searchClause = or(
        ilike(users.name, `%${query.search}%`),
        ilike(users.designation, `%${query.search}%`),
      );
      if (searchClause) conditions.push(searchClause);
    }

    const latestDocs = this.db
      .selectDistinctOn([onboardingDocuments.userId, onboardingDocuments.documentTypeId], {
        userId: onboardingDocuments.userId,
        documentTypeId: onboardingDocuments.documentTypeId,
        status: onboardingDocuments.status,
      })
      .from(onboardingDocuments)
      .where(eq(onboardingDocuments.orgId, orgId))
      .orderBy(onboardingDocuments.userId, onboardingDocuments.documentTypeId, desc(onboardingDocuments.id))
      .as("latest_docs");

    const offset = (query.page - 1) * query.limit;

    const [[mandatoryCountRow], rows, [countRow]] = await Promise.all([
      this.db
        .select({ total: count() })
        .from(documentTypes)
        .where(
          and(
            eq(documentTypes.orgId, orgId),
            eq(documentTypes.isActive, true),
            eq(documentTypes.isMandatory, true),
          ),
        ),
      this.db
        .select({
          userId: users.id,
          userName: users.name,
          userImage: users.image,
          designation: users.designation,
          employeeId: users.employeeId,
          onboardingDocStatus: users.onboardingDocStatus,
          totalSubmitted: sql<number>`count(${latestDocs.status}) filter (where ${latestDocs.status} in ('SUBMITTED', 'RE_UPLOAD_REQUESTED', 'APPROVED', 'REJECTED'))::int`,
          totalApproved: sql<number>`count(${latestDocs.status}) filter (where ${latestDocs.status} = 'APPROVED')::int`,
          totalRejected: sql<number>`count(${latestDocs.status}) filter (where ${latestDocs.status} = 'REJECTED')::int`,
        })
        .from(users)
        .innerJoin(
          organizationMembers,
          and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, orgId)),
        )
        .leftJoin(latestDocs, eq(latestDocs.userId, users.id))
        .where(and(...conditions))
        .groupBy(users.id, users.name, users.image, users.designation, users.employeeId, users.onboardingDocStatus)
        .orderBy(users.name)
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(users)
        .innerJoin(
          organizationMembers,
          and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, orgId)),
        )
        .where(and(...conditions)),
    ]);

    const totalRequired = mandatoryCountRow?.total ?? 0;
    const total = countRow?.total ?? 0;

    return {
      data: rows.map((row) => ({ ...row, totalRequired })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async list(
    orgId: string,
    actorUserId: string,
    isAdmin: boolean,
    query: ListOnboardingDocsQueryInput,
    scope: DataScope,
  ) {
    if (isAdmin && query.userId && query.userId !== actorUserId && scope !== "all") {
      throw new ForbiddenException("Not authorized to filter onboarding documents for another employee");
    }

    const conditions: SQL[] = [eq(onboardingDocuments.orgId, orgId)];
    if (isAdmin) {
      conditions.push(applyScope(scope, orgId, actorUserId, { ownerColumn: onboardingDocuments.userId }));
      if (query.userId && scope === "all") {
        conditions.push(eq(onboardingDocuments.userId, query.userId));
      }
    } else {
      conditions.push(eq(onboardingDocuments.userId, actorUserId));
    }
    if (query.status) conditions.push(eq(onboardingDocuments.status, query.status));

    const whereClause = and(...conditions);
    const offset = (query.page - 1) * query.limit;

    const [rows, [countRow]] = await Promise.all([
      this.db
        .select({
          id: onboardingDocuments.id,
          orgId: onboardingDocuments.orgId,
          userId: onboardingDocuments.userId,
          employeeName: users.name,
          documentTypeId: onboardingDocuments.documentTypeId,
          documentTypeName: documentTypes.name,
          isMandatory: documentTypes.isMandatory,
          fileUrl: onboardingDocuments.fileUrl,
          fileName: onboardingDocuments.fileName,
          fileSize: onboardingDocuments.fileSize,
          mimeType: onboardingDocuments.mimeType,
          version: onboardingDocuments.version,
          status: onboardingDocuments.status,
          reviewedBy: onboardingDocuments.reviewedBy,
          reviewedAt: onboardingDocuments.reviewedAt,
          remarks: onboardingDocuments.remarks,
          createdAt: onboardingDocuments.createdAt,
          updatedAt: onboardingDocuments.updatedAt,
          reviewerName: reviewerUsers.name,
        })
        .from(onboardingDocuments)
        .innerJoin(documentTypes, eq(onboardingDocuments.documentTypeId, documentTypes.id))
        .innerJoin(users, eq(onboardingDocuments.userId, users.id))
        .leftJoin(reviewerUsers, eq(onboardingDocuments.reviewedBy, reviewerUsers.id))
        .where(whereClause)
        .orderBy(desc(onboardingDocuments.createdAt))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(onboardingDocuments)
        .where(whereClause),
    ]);

    const total = countRow?.total ?? 0;

    return {
      data: rows,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async create(
    orgId: string,
    actorUserId: string,
    isAdmin: boolean,
    body: CreateOnboardingDocInput,
    scope: DataScope,
  ) {
    let targetUserId = actorUserId;
    if (body.targetUserId && body.targetUserId !== actorUserId) {
      if (!isAdmin) {
        throw new ForbiddenException("Only HR admins can upload documents on behalf of employees.");
      }
      if (scope !== "all") {
        throw new ForbiddenException("Not authorized to upload onboarding documents for another employee");
      }
      targetUserId = body.targetUserId;
    }

    const [docType] = await this.db
      .select({ id: documentTypes.id, name: documentTypes.name })
      .from(documentTypes)
      .where(
        and(
          eq(documentTypes.id, body.documentTypeId),
          eq(documentTypes.orgId, orgId),
          eq(documentTypes.isActive, true),
        ),
      )
      .limit(1);

    if (!docType) throw new NotFoundException("Document type not found or inactive.");

    const existing = await this.db
      .select({ id: onboardingDocuments.id, version: onboardingDocuments.version })
      .from(onboardingDocuments)
      .where(
        and(
          eq(onboardingDocuments.orgId, orgId),
          eq(onboardingDocuments.userId, targetUserId),
          eq(onboardingDocuments.documentTypeId, body.documentTypeId),
        ),
      )
      .orderBy(desc(onboardingDocuments.version))
      .limit(1);

    const isReUpload = existing.length > 0;
    const nextVersion = isReUpload ? existing[0].version + 1 : 1;
    const auditAction = isReUpload ? ("RE_UPLOADED" as const) : ("UPLOADED" as const);

    const [record] = await this.db
      .insert(onboardingDocuments)
      .values({
        orgId,
        userId: targetUserId,
        documentTypeId: body.documentTypeId,
        fileUrl: body.fileUrl,
        fileName: body.fileName,
        fileSize: body.fileSize,
        mimeType: body.mimeType,
        version: nextVersion,
        status: "SUBMITTED",
      })
      .returning();

    if (!record) throw new InternalServerErrorException("Failed to create onboarding document.");

    const metadata: Record<string, unknown> = {
      fileName: body.fileName,
      version: nextVersion,
      ...(targetUserId !== actorUserId ? { uploadedOnBehalfOf: targetUserId } : {}),
    };

    await this.db.insert(documentAuditLogs).values({
      orgId,
      onboardingDocumentId: record.id,
      action: auditAction,
      performedBy: actorUserId,
      metadata,
    });

    await this.recalcOnboardingStatus(orgId, targetUserId);

    void this.dispatchDocumentSubmittedEvent(orgId, record.id, targetUserId, docType.name);

    return record;
  }

  async getDetail(orgId: string, userId: string, isAdmin: boolean, docId: number) {
    const whereConditions = isAdmin
      ? and(eq(onboardingDocuments.id, docId), eq(onboardingDocuments.orgId, orgId))
      : and(
          eq(onboardingDocuments.id, docId),
          eq(onboardingDocuments.orgId, orgId),
          eq(onboardingDocuments.userId, userId),
        );

    const rows = await this.db
      .select({
        id: onboardingDocuments.id,
        orgId: onboardingDocuments.orgId,
        userId: onboardingDocuments.userId,
        documentTypeId: onboardingDocuments.documentTypeId,
        documentTypeName: documentTypes.name,
        isMandatory: documentTypes.isMandatory,
        fileUrl: onboardingDocuments.fileUrl,
        fileName: onboardingDocuments.fileName,
        fileSize: onboardingDocuments.fileSize,
        mimeType: onboardingDocuments.mimeType,
        version: onboardingDocuments.version,
        status: onboardingDocuments.status,
        reviewedBy: onboardingDocuments.reviewedBy,
        reviewedAt: onboardingDocuments.reviewedAt,
        remarks: onboardingDocuments.remarks,
        createdAt: onboardingDocuments.createdAt,
        updatedAt: onboardingDocuments.updatedAt,
        reviewerName: reviewerUsers.name,
      })
      .from(onboardingDocuments)
      .innerJoin(documentTypes, eq(onboardingDocuments.documentTypeId, documentTypes.id))
      .leftJoin(reviewerUsers, eq(onboardingDocuments.reviewedBy, reviewerUsers.id))
      .where(whereConditions)
      .limit(1);

    if (rows.length === 0) throw new NotFoundException("Document not found.");

    const doc = rows[0];

    const auditRows = await this.db
      .select({
        id: documentAuditLogs.id,
        action: documentAuditLogs.action,
        performedBy: documentAuditLogs.performedBy,
        performedByName: users.name,
        remarks: documentAuditLogs.remarks,
        metadata: documentAuditLogs.metadata,
        createdAt: documentAuditLogs.createdAt,
      })
      .from(documentAuditLogs)
      .innerJoin(users, eq(documentAuditLogs.performedBy, users.id))
      .where(eq(documentAuditLogs.onboardingDocumentId, docId))
      .orderBy(desc(documentAuditLogs.createdAt));

    return { ...doc, auditLogs: auditRows };
  }

  async review(orgId: string, userId: string, docId: number, body: ReviewOnboardingDocInput) {
    const [existing] = await this.db
      .select({ id: onboardingDocuments.id, userId: onboardingDocuments.userId, status: onboardingDocuments.status })
      .from(onboardingDocuments)
      .where(and(eq(onboardingDocuments.id, docId), eq(onboardingDocuments.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Document not found.");

    const [updated] = await this.db
      .update(onboardingDocuments)
      .set({
        status: body.status,
        reviewedBy: userId,
        reviewedAt: new Date(),
        remarks: body.remarks,
      })
      .where(and(eq(onboardingDocuments.id, docId), eq(onboardingDocuments.orgId, orgId)))
      .returning();

    await this.db.insert(documentAuditLogs).values({
      orgId,
      onboardingDocumentId: docId,
      action: body.status,
      performedBy: userId,
      remarks: body.remarks,
      metadata: { previousStatus: existing.status },
    });

    await this.recalcOnboardingStatus(orgId, existing.userId);

    return updated;
  }

  private async recalcOnboardingStatus(orgId: string, targetUserId: string): Promise<void> {
    const mandatoryTypes = await this.db
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(
        and(
          eq(documentTypes.orgId, orgId),
          eq(documentTypes.isActive, true),
          eq(documentTypes.isMandatory, true),
        ),
      );

    if (mandatoryTypes.length === 0) {
      await this.db
        .update(users)
        .set({ onboardingDocStatus: "APPROVED" })
        .where(eq(users.id, targetUserId));
      return;
    }

    const mandatoryTypeIds = mandatoryTypes.map((t) => t.id);

    const userDocs = await this.db
      .select({ documentTypeId: onboardingDocuments.documentTypeId, status: onboardingDocuments.status })
      .from(onboardingDocuments)
      .where(and(eq(onboardingDocuments.orgId, orgId), eq(onboardingDocuments.userId, targetUserId)))
      .orderBy(desc(onboardingDocuments.id));

    const latestByType = new Map<number, string>();
    for (const doc of userDocs) {
      if (!latestByType.has(doc.documentTypeId)) {
        latestByType.set(doc.documentTypeId, doc.status);
      }
    }

    const allApproved = mandatoryTypeIds.every((id) => latestByType.get(id) === "APPROVED");
    const anyInProgress = mandatoryTypeIds.some((id) => {
      const s = latestByType.get(id);
      return s === "SUBMITTED" || s === "RE_UPLOAD_REQUESTED";
    });

    const newStatus = allApproved ? ("APPROVED" as const) : anyInProgress ? ("IN_PROGRESS" as const) : ("PENDING" as const);

    await this.db
      .update(users)
      .set({ onboardingDocStatus: newStatus })
      .where(eq(users.id, targetUserId));
  }

  private dispatchDocumentSubmittedEvent(
    orgId: string,
    documentId: number,
    targetUserId: string,
    documentTypeName: string,
  ): Promise<void> {
    return this.automation
      .runAutomationsForEvent(orgId, "onboarding.document_submitted", {
        documentId,
        userId: targetUserId,
        documentTypeName,
        status: "SUBMITTED",
        submittedAt: new Date().toISOString(),
      })
      .catch(() => undefined);
  }
}
