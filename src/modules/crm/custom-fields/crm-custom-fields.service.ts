import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { customFieldDefinitions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfterIntValue } from "../../../common/pagination/keyset";
import { CRM_CUSTOM_FIELD_ENTITY_TYPES } from "./dto/crm-custom-fields.schemas";
import type {
  CreateCustomFieldInput,
  CustomFieldsListInput,
  UpdateCustomFieldInput,
} from "./dto/crm-custom-fields.schemas";

/**
 * The rows this route may reach at all.
 *
 * `custom_field_definitions` is one table serving four modules. The create
 * payload has always been CRM-only, but `updateCustomField` and
 * `deleteCustomField` took a bare `fieldId` and keyed on `(id, org_id)` — so a
 * holder of the old global settings key, which no module rung carried,
 * could rename or drop a Support ticket field or an HR employee field through a
 * global settings path that never mentions those modules. Naming the owned
 * entity types in the predicate makes a foreign row indistinguishable from a
 * missing one, which is the 404 a caller with no business knowing it exists
 * should get.
 */
const OWNED_ENTITY_TYPES = inArray(
  customFieldDefinitions.entityType,
  [...CRM_CUSTOM_FIELD_ENTITY_TYPES],
);

/**
 * The read contract is `name`/`sortOrder`, not the column names.
 *
 * The write payloads have always spoken `name` and `sortOrder`, and the client
 * type declares them, but the read was a bare `.select()` that returned `key`
 * and `displayOrder` — so the two halves of the same resource disagreed and the
 * list rendered blank names. Projecting explicitly is what makes the two halves
 * one contract; it also stops `org_id`, `settings` and `is_sensitive` leaving on
 * a list nobody asked them for.
 */
const CUSTOM_FIELD_PROJECTION = {
  id: customFieldDefinitions.id,
  entityType: customFieldDefinitions.entityType,
  name: customFieldDefinitions.key,
  label: customFieldDefinitions.label,
  fieldType: customFieldDefinitions.fieldType,
  options: customFieldDefinitions.options,
  isRequired: customFieldDefinitions.isRequired,
  isActive: customFieldDefinitions.isActive,
  sortOrder: customFieldDefinitions.displayOrder,
  createdAt: customFieldDefinitions.createdAt,
  updatedAt: customFieldDefinitions.updatedAt,
} as const;

@Injectable()
export class CrmCustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listCustomFields(orgId: string, params: CustomFieldsListInput) {
    const limit = params.limit;
    const position = decodeCursor(params.cursor);

    const rows = await this.db
      .select(CUSTOM_FIELD_PROJECTION)
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          params.entityType
            ? eq(customFieldDefinitions.entityType, params.entityType)
            : OWNED_ENTITY_TYPES,
          position
            ? keysetAfterIntValue(
                customFieldDefinitions.displayOrder,
                customFieldDefinitions.id,
                position,
              )
            : undefined,
        ),
      )
      .orderBy(asc(customFieldDefinitions.displayOrder), asc(customFieldDefinitions.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.sortOrder),
      id: String(row.id),
    }));

    return { fields: page.data, pagination: page.pagination };
  }

  async createCustomField(orgId: string, userId: string, input: CreateCustomFieldInput) {
    const existing = await this.db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, input.entityType),
          eq(customFieldDefinitions.key, input.name),
        ),
      )
      .limit(1);

    if (existing.length > 0)
      throw new ConflictException(`A field named "${input.name}" already exists for ${input.entityType}`);

    const [created] = await this.db
      .insert(customFieldDefinitions)
      .values({
        orgId,
        entityType: input.entityType,
        key: input.name,
        label: input.label,
        fieldType: input.fieldType,
        options: input.options ?? null,
        isRequired: input.isRequired ?? false,
        isActive: true,
        displayOrder: input.sortOrder ?? 0,
      })
      .returning(CUSTOM_FIELD_PROJECTION);

    return { field: created };
  }

  async updateCustomField(orgId: string, fieldId: number, input: UpdateCustomFieldInput) {
    const [existing] = await this.db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.id, fieldId),
          eq(customFieldDefinitions.orgId, orgId),
          OWNED_ENTITY_TYPES,
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Field not found");

    const [updated] = await this.db
      .update(customFieldDefinitions)
      .set({
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.options !== undefined ? { options: input.options } : {}),
        ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { displayOrder: input.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customFieldDefinitions.id, fieldId),
          eq(customFieldDefinitions.orgId, orgId),
          OWNED_ENTITY_TYPES,
        ),
      )
      .returning(CUSTOM_FIELD_PROJECTION);

    return { field: updated };
  }

  async deleteCustomField(orgId: string, fieldId: number) {
    const [existing] = await this.db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.id, fieldId),
          eq(customFieldDefinitions.orgId, orgId),
          OWNED_ENTITY_TYPES,
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Field not found");

    await this.db
      .delete(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.id, fieldId),
          eq(customFieldDefinitions.orgId, orgId),
          OWNED_ENTITY_TYPES,
        ),
      );

    return { success: true };
  }
}
