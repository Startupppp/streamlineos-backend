import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { SQL, and, count, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import {
  certifications,
  documents,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { ScopedRead } from "../../access/scoped-read";
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
import {
  documentCategoryCondition,
  documentListSelection,
  documentOwnerScope,
  documentReadableScope,
  formatDateString,
  isCompanyLevelDocument,
} from "./documents-helpers";

// Refused rather than clamped: silently storing `false` would tell the caller their document is public when it is not.
function assertPublicFlagEligible(
  isPublic: boolean,
  row: { type: string; userId: string | null; uploadedBy: string | null },
): void {
  if (!isPublic || isCompanyLevelDocument(row)) return;
  throw new HttpException(
    {
      code: "DOCUMENT_NOT_PUBLIC_ELIGIBLE",
      message:
        "Only a company policy or general document that belongs to no employee can be made public.",
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // Below `all`, every document a caller may reach is reached through their membership row; without one there is nothing to scope to.
  private assertMembershipForScope(read: ScopedRead, membershipId?: number | null): void {
    if (!read.unrestricted && membershipId == null)
      throw new ForbiddenException("Organization membership required.");
  }

  private scopedWhere(
    read: ScopedRead,
    membershipId: number | null | undefined,
    and: (SQL | undefined)[],
  ): SQL | null {
    this.assertMembershipForScope(read, membershipId);
    return read.compose(
      { tenant: documents.orgId, scope: documentOwnerScope(read.actorId, membershipId), and },
      (where) => where.sql,
      () => null,
    );
  }

  async listDocuments(
    read: ScopedRead,
    filters: ListDocumentsInput,
    membershipId?: number | null,
  ) {
    const orgId = read.orgId;
    this.assertMembershipForScope(read, membershipId);
    const conditions: SQL[] = [eq(documents.isActive, true)];
    if (filters.userId && read.unrestricted) {
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
      const createdAt = new Date(cursor.createdAt).toISOString();
      conditions.push(
        sql`(
          ${documents.createdAt} < ${createdAt}::timestamptz
          OR (${documents.createdAt} = ${createdAt}::timestamptz AND ${documents.id} < ${cursor.documentId})
        )`,
      );
    }

    const rows = await read.read(
      {
        tenant: documents.orgId,
        scope: documentOwnerScope(read.actorId, membershipId),
        and: conditions,
      },
      ({ sql: whereClause }) => this.db
        .select(documentListSelection)
        .from(documents)
        .where(whereClause)
        .orderBy(desc(documents.createdAt), desc(documents.id))
        .limit(filters.limit + 1),
      () => [],
    );
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
    read: ScopedRead,
    documentId: number,
    membershipId?: number | null,
  ): Promise<{ documentId: number; fileUrl: string; fileName: string }> {
    this.assertMembershipForScope(read, membershipId);
    const [document] = await read.read(
      {
        tenant: documents.orgId,
        scope: documentReadableScope(read.actorId, membershipId),
        and: [eq(documents.id, documentId), eq(documents.isActive, true)],
      },
      ({ sql: where }) => this.db
        .select({
          documentId: documents.id,
          fileUrl: documents.fileUrl,
          fileName: sql<string>`coalesce(${documents.fileName}, ${documents.name})`,
        })
        .from(documents)
        .where(where)
        .limit(1),
      () => [],
    );

    if (!document) throw new NotFoundException("Document not found.");
    return document;
  }

  async createDocument(
    read: ScopedRead,
    input: CreateDocumentInput,
    membershipId?: number | null,
  ) {
    const orgId = read.orgId;
    const userId = read.actorId;
    const targetUserId = input.userId ?? userId;
    assertPublicFlagEligible(input.isPublic ?? false, {
      type: input.type,
      userId: targetUserId,
      uploadedBy: userId,
    });
    const targetMember = await read.read(
      {
        tenant: organizationMembers.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
        and: [eq(organizationMembers.userId, targetUserId)],
      },
      ({ sql: where }) =>
        this.db.query.organizationMembers.findFirst({
          where,
          columns: { id: true },
        }),
      () => undefined,
    );
    if (!targetMember) {
      throw new NotFoundException(
        "Target user not found in your organization.",
      );
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
    read: ScopedRead,
    documentId: number,
    input: UpdateDocumentInput,
    membershipId?: number | null,
  ) {
    const orgId = read.orgId;
    const doc = await this.db.query.documents.findFirst({
      where: this.scopedWhere(read, membershipId, [eq(documents.id, documentId)]) ?? sql`false`,
      columns: { id: true, userId: true, name: true, type: true, isPublic: true, uploadedBy: true },
    });
    if (!doc) throw new NotFoundException("Document not found.");

    // Only a request that touches the flag, the type or the owner is judged, so a legacy row that is
    // already public-and-personal can still have its name or expiry edited; the read path stops
    // honouring the flag on such a row regardless (documentReadableScope).
    if (input.isPublic !== undefined || input.type !== undefined || input.userId !== undefined) {
      assertPublicFlagEligible(input.isPublic ?? doc.isPublic, {
        type: input.type ?? doc.type,
        userId: input.userId !== undefined ? input.userId : doc.userId,
        uploadedBy: doc.uploadedBy,
      });
    }

    const requestedUserId = input.userId;
    const targetMember =
      requestedUserId == null
        ? null
        : await read.read(
            {
              tenant: organizationMembers.orgId,
              scope: { columns: { ownerColumn: organizationMembers.userId } },
              and: [eq(organizationMembers.userId, requestedUserId)],
            },
            ({ sql: where }) => this.db.query.organizationMembers.findFirst({ where }),
            () => undefined,
          );
    if (requestedUserId != null) {
      if (!targetMember) {
        throw new NotFoundException(
          "Target user not found in your permitted scope.",
        );
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
            ...(input.category !== undefined
              ? { category: input.category ?? null }
              : {}),
            ...(input.userId !== undefined
              ? {
                  userId: input.userId ?? null,
                  userMembershipId: targetMember?.id ?? null,
                }
              : {}),
            ...(input.isPublic !== undefined
              ? { isPublic: input.isPublic }
              : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.expiryDate !== undefined
              ? { expiryDate: input.expiryDate ?? null }
              : {}),
            updatedAt: new Date(),
          })
          .where(this.scopedWhere(read, membershipId, [eq(documents.id, documentId)]) ?? sql`false`)
          .returning();
        if (!updatedDocument)
          throw new NotFoundException("Document not found.");
        if (input.tags !== undefined)
          await syncDocumentTags(transaction, orgId, documentId, input.tags);
        return updatedDocument;
      },
      { orgId },
    );

    return updated;
  }

  async deleteDocument(
    read: ScopedRead,
    documentId: number,
    membershipId?: number | null,
  ) {
    const orgId = read.orgId;
    const doc = await this.db.query.documents.findFirst({
      where: this.scopedWhere(read, membershipId, [eq(documents.id, documentId)]) ?? sql`false`,
      columns: { id: true, userId: true, name: true },
    });
    if (!doc) throw new NotFoundException("Document not found.");

    await this.db
      .update(documents)
      .set({ isActive: false })
      .where(this.scopedWhere(read, membershipId, [eq(documents.id, documentId)]) ?? sql`false`);

    await this.audit.logCritical({
      action: "hr.document_deleted",
      userId: read.actorId,
      orgId,
      targetId: String(documentId),
      targetType: "document",
      metadata: { name: doc.name },
    });

    return { success: true };
  }

  async stats(
    read: ScopedRead,
    membershipId?: number | null,
  ) {
    const orgId = read.orgId;
    const baseWhere =
      this.scopedWhere(read, membershipId, [eq(documents.isActive, true)]) ?? sql`false`;

    const horizon = formatDateString(
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    );

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

  async expiry(
    read: ScopedRead,
    daysAhead: number,
    membershipId?: number | null,
  ) {
    const orgId = read.orgId;
    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);
    const todayStr = formatDateString(now);
    const futureStr = formatDateString(futureDate);

    const docConditions = [
      this.scopedWhere(read, membershipId, [
        eq(documents.isActive, true),
        gte(documents.expiryDate, todayStr),
        lte(documents.expiryDate, futureStr),
      ]) ?? sql`false`,
    ];

    const [expiringDocs, expiringCerts] = await Promise.all([
      this.db
        .select(documentListSelection)
        .from(documents)
        .where(and(...docConditions))
        .orderBy(documents.expiryDate, documents.id)
        .limit(100),
      read.read(
        {
          tenant: certifications.orgId,
          scope: { columns: { ownerColumn: certifications.userId } },
          and: [gte(certifications.expiryDate, todayStr), lte(certifications.expiryDate, futureStr)],
        },
        ({ sql: where }) =>
          this.db.query.certifications.findMany({
            where,
            with: { user: { columns: { id: true, name: true } } },
            orderBy: [certifications.expiryDate, certifications.id],
            limit: 100,
          }),
        () => [],
      ),
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
