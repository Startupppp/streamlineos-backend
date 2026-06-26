import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { richDocuments } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CreateRichDocumentInput,
  UpdateRichDocumentInput,
} from "./dto/documents.schemas";

@Injectable()
export class RichDocumentsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db.query.richDocuments.findMany({
      where: eq(richDocuments.orgId, orgId),
      orderBy: [desc(richDocuments.updatedAt)],
    });
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
      .where(eq(richDocuments.id, documentId));

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
      .where(eq(richDocuments.id, documentId));

    return { success: true };
  }
}
