import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { certifications, documents, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { AuditService } from "../../common/audit/audit.service";
import { DOCUMENT_TYPES, type DocumentType } from "./dto/documents.schemas";
import type {
  CreateDocumentInput,
  ListDocumentsInput,
  UpdateDocumentInput,
} from "./dto/documents.schemas";

function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}

function formatDateString(value: Date): string {
  return value.toISOString().split("T")[0];
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  listDocuments(orgId: string, userId: string, scope: DataScope, filters: ListDocumentsInput) {
    const conditions = [eq(documents.orgId, orgId), eq(documents.isActive, true)];
    conditions.push(applyScope(scope, userId, { ownerColumn: documents.userId }));
    if (filters.userId && scope === "all") {
      conditions.push(eq(documents.userId, filters.userId));
    }
    if (filters.type && isDocumentType(filters.type)) {
      conditions.push(eq(documents.type, filters.type));
    }

    return this.db.query.documents.findMany({
      where: and(...conditions),
      orderBy: [desc(documents.createdAt)],
      limit: 100,
    });
  }

  async createDocument(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    input: CreateDocumentInput,
  ) {
    const targetUserId = input.userId && isAdmin ? input.userId : userId;

    if (targetUserId !== userId) {
      const targetMember = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, targetUserId),
          eq(organizationMembers.orgId, orgId),
        ),
      });
      if (!targetMember) {
        throw new NotFoundException("Target user not found in your organization.");
      }
    }

    const [document] = await this.db
      .insert(documents)
      .values({
        orgId,
        userId: targetUserId,
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

    this.audit.log({
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
    isAdmin: boolean,
    documentId: number,
    input: UpdateDocumentInput,
  ) {
    const doc = await this.db.query.documents.findFirst({
      where: and(eq(documents.id, documentId), eq(documents.orgId, orgId)),
      columns: { id: true, userId: true, name: true },
    });
    if (!doc) throw new NotFoundException("Document not found.");

    const isOwner = doc.userId === userId;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException("Not authorized to update this document.");
    }

    const [updated] = await this.db
      .update(documents)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.category !== undefined ? { category: input.category ?? null } : {}),
        ...(input.userId !== undefined ? { userId: input.userId ?? null } : {}),
        ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), eq(documents.orgId, orgId)))
      .returning();

    return updated;
  }

  async deleteDocument(orgId: string, userId: string, isAdmin: boolean, documentId: number) {
    const doc = await this.db.query.documents.findFirst({
      where: and(eq(documents.id, documentId), eq(documents.orgId, orgId)),
      columns: { id: true, userId: true, name: true },
    });
    if (!doc) throw new NotFoundException("Document not found.");

    const isOwner = doc.userId === userId;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException("Not authorized to delete this document.");
    }

    await this.db
      .update(documents)
      .set({ isActive: false })
      .where(and(eq(documents.id, documentId), eq(documents.orgId, orgId)));

    this.audit.log({
      action: "hr.document_deleted",
      userId,
      orgId,
      targetId: String(documentId),
      targetType: "document",
      metadata: { name: doc.name },
    });

    return { success: true };
  }

  async stats(orgId: string, userId: string, scope: DataScope) {
    const baseWhere = and(
      eq(documents.orgId, orgId),
      eq(documents.isActive, true),
      applyScope(scope, userId, { ownerColumn: documents.userId }),
    );

    const horizon = formatDateString(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

    const [byType, total, expiringCount] = await Promise.all([
      this.db
        .select({ type: documents.type, count: count() })
        .from(documents)
        .where(baseWhere)
        .groupBy(documents.type),
      this.db.select({ count: count() }).from(documents).where(baseWhere),
      this.db
        .select({ count: count() })
        .from(documents)
        .where(
          and(
            baseWhere,
            sql`${documents.expiryDate} IS NOT NULL`,
            sql`${documents.expiryDate} <= ${horizon}`,
            sql`${documents.expiryDate} >= CURRENT_DATE`,
          ),
        ),
    ]);

    return {
      total: total[0]?.count ?? 0,
      byType: Object.fromEntries(byType.map((r) => [r.type, r.count])),
      expiringIn30Days: expiringCount[0]?.count ?? 0,
    };
  }

  async expiry(orgId: string, daysAhead: number) {
    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);
    const todayStr = formatDateString(now);
    const futureStr = formatDateString(futureDate);

    const [expiringDocs, expiringCerts] = await Promise.all([
      this.db.query.documents.findMany({
        where: and(
          eq(documents.orgId, orgId),
          eq(documents.isActive, true),
          gte(documents.expiryDate, todayStr),
          lte(documents.expiryDate, futureStr),
        ),
      }),
      this.db.query.certifications.findMany({
        where: and(
          eq(certifications.orgId, orgId),
          gte(certifications.expiryDate, todayStr),
          lte(certifications.expiryDate, futureStr),
        ),
        with: { user: { columns: { id: true, name: true } } },
      }),
    ]);

    return {
      expiringDocuments: expiringDocs,
      expiringCertifications: expiringCerts,
      totalExpiring: expiringDocs.length + expiringCerts.length,
    };
  }
}
