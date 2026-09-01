import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SQL, and, count, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { certifications, documents, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { AuditService } from "../../../common/audit/audit.service";
import { resolveCompatibleList } from "../../../common/db/expand-contract-compat";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type {
  CreateDocumentInput,
  ListDocumentsInput,
  UpdateDocumentInput,
} from "./dto/documents.schemas";
import {
  decodeDocumentListCursor,
  encodeDocumentListCursor,
} from "./document-list-cursor";
import { loadDocumentTags, syncDocumentTags } from "./document-tag-compat";

function formatDateString(value: Date): string {
  return value.toISOString().split("T")[0];
}

function documentOwnerPredicate(
  scope: DataScope,
  orgId: string,
  userId: string,
  membershipId?: number | null,
): SQL {
  if (scope === "own") {
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    return eq(documents.userMembershipId, membershipId);
  }
  return applyScope(scope, orgId, userId, { ownerColumn: documents.userId });
}

function documentCategoryCondition(category: string): SQL {
  switch (category) {
    case "Contracts":
      return sql`${documents.type} IN ('CONTRACT', 'OFFER_LETTER')`;
    case "Policies":
      return eq(documents.type, "POLICY");
    case "Tax Forms":
      return sql`(${documents.type} = 'ID_PROOF' OR 'tax' = ANY(${documents.tags}))`;
    case "Templates":
      return sql`'template' = ANY(${documents.tags})`;
    case "Payroll":
      return eq(documents.type, "PAYSLIP");
    case "Archives":
      return eq(documents.type, "OTHER");
    default:
      return sql`(
        ${documents.category} = ${category}
        OR ${category} = ANY(${documents.tags})
      )`;
  }
}

const documentListSelection = {
  id: documents.id,
  orgId: documents.orgId,
  userId: documents.userId,
  departmentId: documents.departmentId,
  name: documents.name,
  description: documents.description,
  type: documents.type,
  category: documents.category,
  hasFile: sql<boolean>`${documents.fileUrl} <> ''`,
  fileName: documents.fileName,
  fileSize: documents.fileSize,
  mimeType: documents.mimeType,
  version: documents.version,
  parentDocumentId: documents.parentDocumentId,
  isPublic: documents.isPublic,
  isActive: documents.isActive,
  expiryDate: documents.expiryDate,
  expiryReminderSent: documents.expiryReminderSent,
  tags: documents.tags,
  metadata: documents.metadata,
  uploadedBy: documents.uploadedBy,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listDocuments(orgId: string, userId: string, scope: DataScope, filters: ListDocumentsInput, membershipId?: number | null) {
    const conditions: SQL[] = [
      eq(documents.orgId, orgId),
      eq(documents.isActive, true),
    ];
    conditions.push(documentOwnerPredicate(scope, orgId, userId, membershipId));
    if (filters.userId && scope === "all") {
      conditions.push(eq(documents.userId, filters.userId));
    }
    if (filters.type) {
      conditions.push(eq(documents.type, filters.type));
    }
    if (filters.search) {
      const search = `%${filters.search}%`;
      conditions.push(
        sql`(
          ${documents.name} ILIKE ${search}
          OR ${documents.description} ILIKE ${search}
          OR ${documents.category} ILIKE ${search}
          OR array_to_string(${documents.tags}, ' ') ILIKE ${search}
        )`,
      );
    }
    if (filters.category && filters.category !== "All Files") {
      conditions.push(documentCategoryCondition(filters.category));
    }
    const cursor = filters.cursor
      ? decodeDocumentListCursor(filters.cursor)
      : undefined;
    if (cursor) {
      const createdAt = new Date(cursor.createdAt);
      conditions.push(
        sql`(
          ${documents.createdAt} < ${createdAt}
          OR (${documents.createdAt} = ${createdAt} AND ${documents.id} < ${cursor.documentId})
        )`,
      );
    }

    const whereClause = and(...conditions);
    const rows = await this.db
      .select(documentListSelection)
      .from(documents)
      .where(whereClause)
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(filters.limit + 1);
    const hasMore = rows.length > filters.limit;
    const data = rows.slice(0, filters.limit);
    const tagsByDocumentId = await loadDocumentTags(
      this.db,
      orgId,
      data.map((document) => document.id),
    );
    const compatibleData = data.map((document) => ({
      ...document,
      tags: resolveCompatibleList(
        document.tags,
        tagsByDocumentId.get(document.id),
      ),
    }));
    const last = compatibleData.at(-1);

    return {
      data: compatibleData,
      pageInfo: {
        limit: filters.limit,
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeDocumentListCursor({
                createdAt: new Date(last.createdAt).toISOString(),
                documentId: last.id,
              })
            : null,
      },
    };
  }

  async getFileReference(
    orgId: string,
    userId: string,
    scope: DataScope,
    documentId: number,
    membershipId?: number | null,
  ): Promise<{ documentId: number; fileUrl: string; fileName: string }> {
    const [document] = await this.db
      .select({
        documentId: documents.id,
        fileUrl: documents.fileUrl,
        fileName: sql<string>`coalesce(${documents.fileName}, ${documents.name})`,
      })
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.orgId, orgId),
          eq(documents.isActive, true),
          or(
            eq(documents.isPublic, true),
            documentOwnerPredicate(scope, orgId, userId, membershipId),
          ),
        ),
      )
      .limit(1);

    if (!document) throw new NotFoundException("Document not found.");
    return document;
  }

  async createDocument(
    orgId: string,
    userId: string,
    scope: DataScope,
    input: CreateDocumentInput,
    membershipId?: number | null,
  ) {
    const targetUserId = input.userId ?? userId;
    const targetMember = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, targetUserId),
        eq(organizationMembers.orgId, orgId),
        applyScope(scope, orgId, userId, {
          ownerColumn: organizationMembers.userId,
        }),
      ),
      columns: { id: true },
    });
    if (!targetMember) {
      throw new NotFoundException("Target user not found in your organization.");
    }

    const document = await runInTenantTransaction(
      this.db,
      async (transaction) => {
        const [createdDocument] = await transaction
          .insert(documents)
          .values({
            orgId,
            userId: targetUserId,
            userMembershipId: targetMember.id,
            name: input.name,
            type: input.type,
            fileUrl: input.fileUrl,
            fileName: input.fileName,
            fileSize: input.fileSize,
            mimeType: input.mimeType,
            description: input.description,
            category: input.category,
            isPublic: input.isPublic ?? false,
            expiryDate: input.expiryDate,
            tags: input.tags,
            uploadedBy: userId,
            isActive: true,
            version: 1,
          })
          .returning();
        if (!createdDocument) throw new Error("Failed to create document");
        await syncDocumentTags(
          transaction,
          orgId,
          createdDocument.id,
          input.tags ?? [],
        );
        return createdDocument;
      },
      { orgId },
    );

    await this.audit.logCritical({
      action: "hr.document_uploaded",
      userId,
      orgId,
      targetId: String(document.id),
      targetType: "document",
      metadata: { name: input.name, type: input.type, targetUserId },
    });

    return document;
  }

  async updateDocument(
    orgId: string,
    userId: string,
    scope: DataScope,
    documentId: number,
    input: UpdateDocumentInput,
    membershipId?: number | null,
  ) {
    const doc = await this.db.query.documents.findFirst({
      where: and(
        eq(documents.id, documentId),
        eq(documents.orgId, orgId),
        documentOwnerPredicate(scope, orgId, userId, membershipId),
      ),
      columns: { id: true, userId: true, name: true },
    });
    if (!doc) throw new NotFoundException("Document not found.");

    const requestedUserId = input.userId;
    const targetMember = requestedUserId === undefined
      ? null
      : await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, requestedUserId),
          applyScope(scope, orgId, userId, {
            ownerColumn: organizationMembers.userId,
          }),
        ),
      });
    if (requestedUserId !== undefined) {
      if (!targetMember) {
        throw new NotFoundException("Target user not found in your permitted scope.");
      }
    }

    const updated = await runInTenantTransaction(
      this.db,
      async (transaction) => {
        const [updatedDocument] = await transaction
          .update(documents)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined
              ? { description: input.description ?? null }
              : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.category !== undefined ? { category: input.category ?? null } : {}),
            ...(input.userId !== undefined ? {
              userId: input.userId ?? null,
              userMembershipId: targetMember?.id ?? null,
            } : {}),
            ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.expiryDate !== undefined
              ? { expiryDate: input.expiryDate ?? null }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documents.id, documentId),
              eq(documents.orgId, orgId),
              documentOwnerPredicate(scope, orgId, userId, membershipId),
            ),
          )
          .returning();
        if (!updatedDocument) throw new NotFoundException("Document not found.");
        if (input.tags !== undefined)
          await syncDocumentTags(transaction, orgId, documentId, input.tags);
        return updatedDocument;
      },
      { orgId },
    );

    return updated;
  }

  async deleteDocument(
    orgId: string,
    userId: string,
    scope: DataScope,
    documentId: number,
    membershipId?: number | null,
  ) {
    const doc = await this.db.query.documents.findFirst({
      where: and(
        eq(documents.id, documentId),
        eq(documents.orgId, orgId),
        documentOwnerPredicate(scope, orgId, userId, membershipId),
      ),
      columns: { id: true, userId: true, name: true },
    });
    if (!doc) throw new NotFoundException("Document not found.");

    await this.db
      .update(documents)
      .set({ isActive: false })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.orgId, orgId),
          documentOwnerPredicate(scope, orgId, userId, membershipId),
        ),
      );

    await this.audit.logCritical({
      action: "hr.document_deleted",
      userId,
      orgId,
      targetId: String(documentId),
      targetType: "document",
      metadata: { name: doc.name },
    });

    return { success: true };
  }

  async stats(orgId: string, userId: string, scope: DataScope, membershipId?: number | null) {
    const baseWhere = and(
      eq(documents.orgId, orgId),
      eq(documents.isActive, true),
      documentOwnerPredicate(scope, orgId, userId, membershipId),
    );

    const horizon = formatDateString(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

    const [byType, [summary]] = await Promise.all([
      this.db
        .select({ type: documents.type, count: count() })
        .from(documents)
        .where(baseWhere)
        .groupBy(documents.type),
      this.db
        .select({
          total: count(),
          publicCount: sql<number>`count(*) FILTER (WHERE ${documents.isPublic} = true)`,
          storageBytes: sql<string>`coalesce(sum(${documents.fileSize}), 0)::text`,
          expiringCount: sql<number>`count(*) FILTER (
            WHERE ${documents.expiryDate} IS NOT NULL
              AND ${documents.expiryDate} <= ${horizon}
              AND ${documents.expiryDate} >= CURRENT_DATE
          )`,
        })
        .from(documents)
        .where(baseWhere),
    ]);

    return {
      total: Number(summary?.total ?? 0),
      byType: Object.fromEntries(byType.map((r) => [r.type, r.count])),
      publicCount: Number(summary?.publicCount ?? 0),
      storageBytes: Number(summary?.storageBytes ?? 0),
      expiringIn30Days: Number(summary?.expiringCount ?? 0),
    };
  }

  async expiry(orgId: string, userId: string, scope: DataScope, daysAhead: number, membershipId?: number | null) {
    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);
    const todayStr = formatDateString(now);
    const futureStr = formatDateString(futureDate);

    const docConditions = [
      eq(documents.orgId, orgId),
      eq(documents.isActive, true),
      documentOwnerPredicate(scope, orgId, userId, membershipId),
      gte(documents.expiryDate, todayStr),
      lte(documents.expiryDate, futureStr),
    ];

    const certConditions = [
      eq(certifications.orgId, orgId),
      applyScope(scope, orgId, userId, { ownerColumn: certifications.userId }),
      gte(certifications.expiryDate, todayStr),
      lte(certifications.expiryDate, futureStr),
    ];

    const [expiringDocs, expiringCerts] = await Promise.all([
      this.db
        .select(documentListSelection)
        .from(documents)
        .where(and(...docConditions))
        .orderBy(documents.expiryDate, documents.id)
        .limit(100),
      this.db.query.certifications.findMany({
        where: and(...certConditions),
        with: { user: { columns: { id: true, name: true } } },
        orderBy: [certifications.expiryDate, certifications.id],
        limit: 100,
      }),
    ]);

    const tagsByDocumentId = await loadDocumentTags(
      this.db,
      orgId,
      expiringDocs.map((document) => document.id),
    );
    const compatibleExpiringDocuments = expiringDocs.map((document) => ({
      ...document,
      tags: resolveCompatibleList(
        document.tags,
        tagsByDocumentId.get(document.id),
      ),
    }));

    return {
      expiringDocuments: compatibleExpiringDocuments,
      expiringCertifications: expiringCerts,
      totalExpiring: expiringDocs.length + expiringCerts.length,
    };
  }
}
