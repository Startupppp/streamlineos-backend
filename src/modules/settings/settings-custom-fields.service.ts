import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { customFieldDefinitions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CreateCustomFieldInput, UpdateCustomFieldInput } from "./dto/settings.schemas";

@Injectable()
export class SettingsCustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listCustomFields(orgId: string, entityType?: string) {
    const where = entityType
      ? and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, entityType),
        )
      : eq(customFieldDefinitions.orgId, orgId);

    const fields = await this.db
      .select()
      .from(customFieldDefinitions)
      .where(where)
      .orderBy(asc(customFieldDefinitions.displayOrder), asc(customFieldDefinitions.createdAt));

    return { fields };
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
      .returning();

    return { field: created };
  }

  async updateCustomField(orgId: string, fieldId: number, input: UpdateCustomFieldInput) {
    const [existing] = await this.db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Field not found");

    const [updated] = await this.db
      .update(customFieldDefinitions)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.orgId, orgId)))
      .returning();

    return { field: updated };
  }

  async deleteCustomField(orgId: string, fieldId: number) {
    const [existing] = await this.db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Field not found");

    await this.db
      .delete(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.orgId, orgId)));

    return { success: true };
  }
}
