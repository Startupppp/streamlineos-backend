import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { documentTypes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { toSlug } from "./hr-config.helpers";
import type { CreateDocumentTypeInput, UpdateDocumentTypeInput } from "./dto/document-types.schemas";

@Injectable()
export class HrDocumentTypesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, isAdmin: boolean) {
    return this.db
      .select()
      .from(documentTypes)
      .where(
        isAdmin
          ? eq(documentTypes.orgId, orgId)
          : and(eq(documentTypes.orgId, orgId), eq(documentTypes.isActive, true)),
      )
      .orderBy(asc(documentTypes.sortOrder), asc(documentTypes.name));
  }

  getById(orgId: string, id: number) {
    return this.db.query.documentTypes
      .findFirst({ where: and(eq(documentTypes.id, id), eq(documentTypes.orgId, orgId)) })
      .then((row) => row ?? null);
  }

  async create(orgId: string, input: CreateDocumentTypeInput) {
    const slug = toSlug(input.name);

    const existing = await this.db.query.documentTypes.findFirst({
      where: and(eq(documentTypes.orgId, orgId), eq(documentTypes.slug, slug)),
    });
    if (existing) throw new ConflictException("A document type with this name already exists.");

    const [record] = await this.db
      .insert(documentTypes)
      .values({
        orgId,
        name: input.name,
        slug,
        description: input.description,
        isMandatory: input.isMandatory,
        applicableRoles: input.applicableRoles,
        sortOrder: input.sortOrder,
        isActive: true,
      })
      .returning();

    return record;
  }

  update(orgId: string, id: number, input: UpdateDocumentTypeInput) {
    return this.db
      .update(documentTypes)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.isMandatory !== undefined && { isMandatory: input.isMandatory }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.applicableRoles !== undefined && { applicableRoles: input.applicableRoles }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        updatedAt: new Date(),
      })
      .where(and(eq(documentTypes.id, id), eq(documentTypes.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }

  softDelete(orgId: string, id: number) {
    return this.db
      .update(documentTypes)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(documentTypes.id, id), eq(documentTypes.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }
}
