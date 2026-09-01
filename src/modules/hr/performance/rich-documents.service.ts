import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { SQL, and, desc, eq } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { richDocuments } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateRichDocumentInput,
  ListRichDocumentsInput,
  UpdateRichDocumentInput,
} from "./dto/documents.schemas";

@Injectable()
export class RichDocumentsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: ListRichDocumentsInput) {
    const pos = decodeCursor(query.cursor);
    const conditions: SQL[] = [eq(richDocuments.orgId, orgId)];
    if (query.isPublished !== undefined) conditions.push(eq(richDocuments.isPublished, query.isPublished));
    if (pos) conditions.push(keysetBeforeId(richDocuments.updatedAt, richDocuments.id, pos));

    const rows = await this.db
      .select({
        id: richDocuments.id,
        orgId: richDocuments.orgId,
        title: richDocuments.title,
        templateType: richDocuments.templateType,
        isPublished: richDocuments.isPublished,
        version: richDocuments.version,
        createdBy: richDocuments.createdBy,
        updatedBy: richDocuments.updatedBy,
        createdAt: richDocuments.createdAt,
        updatedAt: richDocuments.updatedAt,
      })
      .from(richDocuments)
      .where(and(...conditions))
      .orderBy(desc(richDocuments.updatedAt), desc(richDocuments.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.updatedAt.toISOString(),
      id: String(row.id),
    }));
  }

  async create(orgId: string, userId: string, input: CreateRichDocumentInput) {
    if (!input.title) throw new BadRequestException("title is required.");

    const [doc] = await this.db
      .insert(richDocuments)
      .values({
        orgId,
        title: input.title,
        templateType: input.templateType,
        contentJson: input.contentJson,
        createdBy: userId,
        isPublished: false,
        version: 1,
      })
      .returning();

    return doc;
  }

  async get(orgId: string, documentId: number) {
    const doc = await this.db.query.richDocuments.findFirst({
      where: and(eq(richDocuments.id, documentId), eq(richDocuments.orgId, orgId)),
    });
    if (!doc) throw new NotFoundException("Document not found.");
    return doc;
  }

  async update(
    orgId: string,
    userId: string,
    documentId: number,
    input: UpdateRichDocumentInput,
  ) {
    const existing = await this.db.query.richDocuments.findFirst({
      where: and(eq(richDocuments.id, documentId), eq(richDocuments.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Document not found.");

    await this.db
      .update(richDocuments)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.contentJson !== undefined && { contentJson: input.contentJson }),
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(richDocuments.id, documentId), eq(richDocuments.orgId, orgId)));

    return { success: true };
  }

  async remove(orgId: string, documentId: number) {
    await this.db
      .delete(richDocuments)
      .where(and(eq(richDocuments.id, documentId), eq(richDocuments.orgId, orgId)));
    return { success: true };
  }

  async togglePublish(orgId: string, documentId: number) {
    const existing = await this.db.query.richDocuments.findFirst({
      where: and(eq(richDocuments.id, documentId), eq(richDocuments.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Document not found.");

    await this.db
      .update(richDocuments)
      .set({ isPublished: !existing.isPublished, updatedAt: new Date() })
      .where(and(eq(richDocuments.id, documentId), eq(richDocuments.orgId, orgId)));

    return { success: true };
  }
}
