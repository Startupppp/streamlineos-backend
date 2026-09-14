import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { documentTypes, documentTypeRoles } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { toSlug } from "./hr-config.helpers";
import type {
  CreateDocumentTypeInput,
  ListDocumentTypesInput,
  UpdateDocumentTypeInput,
} from "./dto/document-types.schemas";
import { boundHrReadLimit } from "../hr-read-limits";
import { buildTupleCursorPage, decodeTupleCursor } from "../../../common/pagination/cursor";
import {
  keysetAfterTuple,
  keysetInteger,
  keysetTextValue,
} from "../../../common/pagination/keyset";

@Injectable()
export class HrDocumentTypesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * `(sort_order, name, id)` ascending — the display sort is two columns and
   * neither is unique per org, so the serial id completes the total order and
   * all three ride in the cursor. Dropping `name` from the cursor would order
   * by something the query does not and repeat rows wherever two types share a
   * sort order.
   */
  async list(orgId: string, isAdmin: boolean, query: ListDocumentTypesInput) {
    const limit = boundHrReadLimit(query.limit ?? 20);

    const conditions = [eq(documentTypes.orgId, orgId)];
    if (!isAdmin) conditions.push(eq(documentTypes.isActive, true));

    const position = decodeTupleCursor(query.cursor, 3);
    if (position) {
      conditions.push(
        keysetAfterTuple([
          { column: documentTypes.sortOrder, value: keysetInteger(position[0] ?? "") },
          { column: documentTypes.name, value: keysetTextValue(position[1] ?? "") },
          { column: documentTypes.id, value: keysetInteger(position[2] ?? "") },
        ]),
      );
    }

    const rows = await this.db.query.documentTypes.findMany({
      where: and(...conditions),
      with: { roles: { columns: { roleSlug: true } } },
      orderBy: [asc(documentTypes.sortOrder), asc(documentTypes.name), asc(documentTypes.id)],
      limit: limit + 1,
    });

    return buildTupleCursorPage(rows, limit, (row) => [
      String(row.sortOrder),
      row.name,
      String(row.id),
    ]);
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

    const record = await this.db.transaction(async (tx) => {
      const [created] = await tx
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

      if (!created) throw new Error("Failed to create document type");

      if (input.applicableRoles && input.applicableRoles.length > 0) {
        await tx.insert(documentTypeRoles).values(
          input.applicableRoles.map((roleSlug) => ({ orgId, documentTypeId: created.id, roleSlug })),
        );
      }

      return created;
    });

    const row = await this.getById(orgId, record.id);
    if (!row) throw new NotFoundException("Document type not found.");
    return row;
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

    const row = await this.getById(orgId, id);
    if (!row) throw new NotFoundException("Document type not found.");
    return row;
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
