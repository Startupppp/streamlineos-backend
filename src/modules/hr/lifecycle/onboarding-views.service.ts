import { ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { SQL, aliasedTable, and, count, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";
import {
  documentAuditLogs,
  documentTypes,
  hrEmployments,
  hrPeople,
  onboardingDocuments,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
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
    if (query.search) {
      const searchClause = or(
        ilike(users.name, `%${query.search}%`),
        ilike(hrEmployments.designation, `%${query.search}%`),
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

    const documentStats = this.db
      .select({
        userId: latestDocs.userId,
        totalSubmitted: sql<number>`count(${latestDocs.status}) filter (where ${latestDocs.status} in ('SUBMITTED', 'RE_UPLOAD_REQUESTED', 'APPROVED', 'REJECTED'))::int`.as(
          "total_submitted",
        ),
        totalApproved: sql<number>`count(${latestDocs.status}) filter (where ${latestDocs.status} = 'APPROVED')::int`.as(
          "total_approved",
        ),
        totalRejected: sql<number>`count(${latestDocs.status}) filter (where ${latestDocs.status} = 'REJECTED')::int`.as(
          "total_rejected",
        ),
        mandatoryApproved: sql<number>`count(${latestDocs.status}) filter (where ${documentTypes.isMandatory} = true and ${latestDocs.status} = 'APPROVED')::int`.as(
          "mandatory_approved",
        ),
        mandatoryInProgress: sql<number>`count(${latestDocs.status}) filter (where ${documentTypes.isMandatory} = true and ${latestDocs.status} in ('SUBMITTED', 'RE_UPLOAD_REQUESTED'))::int`.as(
          "mandatory_in_progress",
        ),
      })
      .from(latestDocs)
      .innerJoin(
        documentTypes,
        and(
          eq(documentTypes.id, latestDocs.documentTypeId),
          eq(documentTypes.orgId, orgId),
          eq(documentTypes.isActive, true),
        ),
      )
      .groupBy(latestDocs.userId)
      .as("document_stats");

    const mandatoryTotals = this.db
      .select({ total: count().as("total") })
      .from(documentTypes)
      .where(
        and(
          eq(documentTypes.orgId, orgId),
          eq(documentTypes.isActive, true),
          eq(documentTypes.isMandatory, true),
        ),
      )
      .as("mandatory_totals");

    const derivedStatus = sql<"PENDING" | "IN_PROGRESS" | "APPROVED">`case
      when ${mandatoryTotals.total} = 0
        or coalesce(${documentStats.mandatoryApproved}, 0) = ${mandatoryTotals.total}
        then 'APPROVED'
      when coalesce(${documentStats.mandatoryInProgress}, 0) > 0
        then 'IN_PROGRESS'
      else 'PENDING'
    end`;
    if (query.status) conditions.push(sql`${derivedStatus} = ${query.status}`);

    const offset = (query.page - 1) * query.limit;

    const [rows, [countRow]] = await Promise.all([
      this.db
        .select({
          userId: users.id,
          userName: users.name,
          userImage: users.image,
          designation: hrEmployments.designation,
          employeeId: hrEmployments.employeeNumber,
          onboardingDocStatus: derivedStatus,
          totalRequired: mandatoryTotals.total,
          totalSubmitted: sql<number>`coalesce(${documentStats.totalSubmitted}, 0)::int`,
          totalApproved: sql<number>`coalesce(${documentStats.totalApproved}, 0)::int`,
          totalRejected: sql<number>`coalesce(${documentStats.totalRejected}, 0)::int`,
        })
        .from(users)
        .innerJoin(
          organizationMembers,
          and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, orgId)),
        )
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .leftJoin(documentStats, eq(documentStats.userId, users.id))
        .innerJoin(mandatoryTotals, sql`true`)
        .where(and(...conditions))
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
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .leftJoin(documentStats, eq(documentStats.userId, users.id))
        .innerJoin(mandatoryTotals, sql`true`)
        .where(and(...conditions)),
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

  async list(
    orgId: string,
    actorUserId: string,
    isAdmin: boolean,
    query: ListOnboardingDocsQueryInput,
    scope: DataScope,
  ) {
    const conditions: SQL[] = [eq(onboardingDocuments.orgId, orgId)];
    if (isAdmin) {
      conditions.push(applyScope(scope, orgId, actorUserId, { ownerColumn: onboardingDocuments.userId }));
      if (query.userId) conditions.push(eq(onboardingDocuments.userId, query.userId));
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
          hasFile: sql<boolean>`${onboardingDocuments.fileUrl} <> ''`,
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

  async getFileReference(
    orgId: string,
    actorUserId: string,
    docId: number,
    scope: DataScope,
  ): Promise<{ id: number; fileUrl: string; fileName: string }> {
    const [document] = await this.db
      .select({
        id: onboardingDocuments.id,
        fileUrl: onboardingDocuments.fileUrl,
        fileName: onboardingDocuments.fileName,
      })
      .from(onboardingDocuments)
      .where(
        and(
          eq(onboardingDocuments.id, docId),
          eq(onboardingDocuments.orgId, orgId),
          applyScope(scope, orgId, actorUserId, {
            ownerColumn: onboardingDocuments.userId,
          }),
        ),
      )
      .limit(1);

    if (!document) throw new NotFoundException("Document not found.");
    return document;
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
      targetUserId = body.targetUserId;
    }

    const result = await this.db.transaction(async (tx) => {
      const [targetMember] = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, targetUserId),
            ne(organizationMembers.status, "INVITED"),
            applyScope(scope, orgId, actorUserId, {
              ownerColumn: organizationMembers.userId,
            }),
          ),
        )
        .limit(1);
      if (!targetMember) throw new NotFoundException("Employee not found.");

      const [docType] = await tx
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
      if (!docType) {
        throw new NotFoundException("Document type not found or inactive.");
      }

      const versionAllocationKey = `${orgId}:${targetUserId}:${body.documentTypeId}`;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${versionAllocationKey}, 0))`,
      );

      const existing = await tx
        .select({ id: onboardingDocuments.id })
        .from(onboardingDocuments)
        .where(
          and(
            eq(onboardingDocuments.orgId, orgId),
            eq(onboardingDocuments.userId, targetUserId),
            eq(onboardingDocuments.documentTypeId, body.documentTypeId),
          ),
        )
        .limit(1);

      const auditAction =
        existing.length > 0 ? ("RE_UPLOADED" as const) : ("UPLOADED" as const);
      const [record] = await tx
        .insert(onboardingDocuments)
        .values({
          orgId,
          userId: targetUserId,
          documentTypeId: body.documentTypeId,
          fileUrl: body.fileUrl,
          fileName: body.fileName,
          fileSize: body.fileSize,
          mimeType: body.mimeType,
          version: sql<number>`(
            SELECT COALESCE(MAX(existing_document.version), 0) + 1
            FROM onboarding_documents AS existing_document
            WHERE existing_document.org_id = ${orgId}
              AND existing_document.user_id = ${targetUserId}
              AND existing_document.document_type_id = ${body.documentTypeId}
          )`,
          status: "SUBMITTED",
        })
        .returning();
      if (!record) {
        throw new InternalServerErrorException(
          "Failed to create onboarding document.",
        );
      }

      await tx.insert(documentAuditLogs).values({
        orgId,
        onboardingDocumentId: record.id,
        action: auditAction,
        performedBy: actorUserId,
        metadata: {
          fileName: body.fileName,
          version: record.version,
          ...(targetUserId !== actorUserId
            ? { uploadedOnBehalfOf: targetUserId }
            : {}),
        },
      });

      return { record, documentTypeName: docType.name };
    });

    const dispatch = () =>
      this.dispatchDocumentSubmittedEvent(
        orgId,
        result.record.id,
        targetUserId,
        result.documentTypeName,
      );
    if (!registerAfterCommit(dispatch)) void dispatch();

    return result.record;
  }

  async review(
    orgId: string,
    actorUserId: string,
    docId: number,
    body: ReviewOnboardingDocInput,
    scope: DataScope,
  ) {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: onboardingDocuments.id,
          userId: onboardingDocuments.userId,
          status: onboardingDocuments.status,
        })
        .from(onboardingDocuments)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, onboardingDocuments.userId),
            ne(organizationMembers.status, "INVITED"),
          ),
        )
        .where(
          and(
            eq(onboardingDocuments.id, docId),
            eq(onboardingDocuments.orgId, orgId),
            applyScope(scope, orgId, actorUserId, {
              ownerColumn: onboardingDocuments.userId,
            }),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundException("Document not found.");

      const [updated] = await tx
        .update(onboardingDocuments)
        .set({
          status: body.status,
          reviewedBy: actorUserId,
          reviewedAt: new Date(),
          remarks: body.remarks,
        })
        .where(
          and(
            eq(onboardingDocuments.id, docId),
            eq(onboardingDocuments.orgId, orgId),
            eq(onboardingDocuments.userId, existing.userId),
          ),
        )
        .returning();

      await tx.insert(documentAuditLogs).values({
        orgId,
        onboardingDocumentId: docId,
        action: body.status,
        performedBy: actorUserId,
        remarks: body.remarks,
        metadata: { previousStatus: existing.status },
      });

      return updated;
    });
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
