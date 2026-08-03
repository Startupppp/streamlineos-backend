import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, max, sql } from "drizzle-orm";
import { documentTypes, documentTypeRoles } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { toSlug } from "./hr-config.helpers";
import type {
  CreateDocumentTypeInput,
  ListDocumentTypesInput,
  UpdateDocumentTypeInput,
} from "./dto/document-types.schemas";

@Injectable()
export class HrDocumentTypesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, isAdmin: boolean, query: ListDocumentTypesInput) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const where = isAdmin
      ? eq(documentTypes.orgId, orgId)
      : and(eq(documentTypes.orgId, orgId), eq(documentTypes.isActive, true));

    const [rows, [totalRow]] = await Promise.all([
      this.db.query.documentTypes.findMany({
        where,
        with: { roles: { columns: { roleSlug: true } } },
        orderBy: [asc(documentTypes.sortOrder), asc(documentTypes.name)],
        limit,
        offset,
      }),
      this.db
        .select({ total: count() })
        .from(documentTypes)
        .where(where),
    ]);

    const total = Number(totalRow?.total ?? 0);
    return {
      data: rows,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  getById(orgId: string, id: number) {
    return this.db.query.documentTypes
      .findFirst({
        where: and(eq(documentTypes.id, id), eq(documentTypes.orgId, orgId)),
        with: { roles: { columns: { roleSlug: true } } },
      })
      .then((row) => row ?? null);
  }

  private async assertNameUnique(orgId: string, name: string, excludeId?: number) {
    const normalised = name.trim().toLowerCase();
    const existing = await this.db.query.documentTypes.findFirst({
      where: and(
        eq(documentTypes.orgId, orgId),
        sql`lower(${documentTypes.name}) = ${normalised}`,
      ),
    });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException("A document type with this name already exists.");
    }
  }

  private async nextSortOrder(orgId: string): Promise<number> {
    const [row] = await this.db
      .select({ maxOrder: max(documentTypes.sortOrder) })
      .from(documentTypes)
      .where(eq(documentTypes.orgId, orgId));
    return (row?.maxOrder ?? 0) + 1;
  }

  async create(orgId: string, input: CreateDocumentTypeInput) {
    await this.assertNameUnique(orgId, input.name);

    const slug = toSlug(input.name);
    const sortOrder = input.sortOrder ?? (await this.nextSortOrder(orgId));

    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .insert(documentTypes)
        .values({
          orgId,
          name: input.name,
          slug,
          description: input.description,
          isMandatory: input.isMandatory,
          sortOrder,
          isActive: true,
        })
        .returning();

      if (!record) throw new Error("Failed to create document type");

      if (input.applicableRoles && input.applicableRoles.length > 0) {
        await tx.insert(documentTypeRoles).values(
          input.applicableRoles.map((roleSlug) => ({ orgId, documentTypeId: record.id, roleSlug })),
        );
      }

      return record;
    });
  }

  async update(orgId: string, id: number, input: UpdateDocumentTypeInput) {
    if (input.name !== undefined) {
      await this.assertNameUnique(orgId, input.name, id);
    }

    const slug = input.name !== undefined ? toSlug(input.name) : undefined;

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(documentTypes)
        .set({
          ...(input.name !== undefined && { name: input.name, slug }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.isMandatory !== undefined && { isMandatory: input.isMandatory }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          updatedAt: new Date(),
        })
        .where(and(eq(documentTypes.id, id), eq(documentTypes.orgId, orgId)))
        .returning();

      if (input.applicableRoles !== undefined) {
        await tx
          .delete(documentTypeRoles)
          .where(and(eq(documentTypeRoles.documentTypeId, id), eq(documentTypeRoles.orgId, orgId)));
        if (input.applicableRoles.length > 0) {
          await tx.insert(documentTypeRoles).values(
            input.applicableRoles.map((roleSlug) => ({ orgId, documentTypeId: id, roleSlug })),
          );
        }
      }

      return updated;
    });
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
