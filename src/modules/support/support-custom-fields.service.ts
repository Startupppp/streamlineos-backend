import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { supportCustomFields, supportTicketCustomFieldValues } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateCustomFieldInput, CustomFieldValueInput, UpdateCustomFieldInput } from "./dto/support.schemas";

@Injectable()
export class SupportCustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listFields(orgId: string, activeOnly = false) {
    return this.db.query.supportCustomFields.findMany({
      where: activeOnly
        ? and(eq(supportCustomFields.orgId, orgId), eq(supportCustomFields.isActive, true))
        : eq(supportCustomFields.orgId, orgId),
      orderBy: (fields, { asc }) => [asc(fields.sortOrder), asc(fields.id)],
    });
  }

  async createField(orgId: string, input: CreateCustomFieldInput) {
    const existing = await this.db.query.supportCustomFields.findFirst({
      where: and(eq(supportCustomFields.orgId, orgId), eq(supportCustomFields.key, input.key)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException(`A custom field with key "${input.key}" already exists`);

    const [field] = await this.db
      .insert(supportCustomFields)
      .values({
        orgId,
        key: input.key,
        label: input.label,
        fieldType: input.fieldType,
        options: input.fieldType === "select" ? (input.options ?? []) : undefined,
        required: input.required,
        category: input.category ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      })
      .returning();
    return field;
  }

  async updateField(orgId: string, fieldId: number, input: UpdateCustomFieldInput) {
    const [updated] = await this.db
      .update(supportCustomFields)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supportCustomFields.id, fieldId), eq(supportCustomFields.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Custom field not found");
    return updated;
  }

  async deleteField(orgId: string, fieldId: number) {
    const [deleted] = await this.db
      .delete(supportCustomFields)
      .where(and(eq(supportCustomFields.id, fieldId), eq(supportCustomFields.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Custom field not found");
    return { success: true };
  }

  async getFieldValues(orgId: string, ticketId: number) {
    return this.db
      .select({
        fieldId: supportTicketCustomFieldValues.fieldId,
        value: supportTicketCustomFieldValues.value,
        key: supportCustomFields.key,
        label: supportCustomFields.label,
        fieldType: supportCustomFields.fieldType,
      })
      .from(supportTicketCustomFieldValues)
      .innerJoin(supportCustomFields, eq(supportCustomFields.id, supportTicketCustomFieldValues.fieldId))
      .where(and(eq(supportTicketCustomFieldValues.orgId, orgId), eq(supportTicketCustomFieldValues.ticketId, ticketId)));
  }

  /**
   * Validates that every fieldId belongs to this org (silently drops any that
   * don't, rather than failing the whole ticket write over a stale client
   * payload) then upserts each value. Required-field enforcement happens at
   * create time only — updates may touch a subset of fields without being
   * forced to resupply every required one.
   */
  async setFieldValues(orgId: string, ticketId: number, values: CustomFieldValueInput[], enforceRequired: boolean) {
    if (values.length === 0 && !enforceRequired) return;

    const fieldIds = values.map((v) => v.fieldId);
    const fields =
      fieldIds.length > 0
        ? await this.db.query.supportCustomFields.findMany({
            where: and(eq(supportCustomFields.orgId, orgId), inArray(supportCustomFields.id, fieldIds)),
          })
        : [];
    const fieldById = new Map(fields.map((f) => [f.id, f]));

    if (enforceRequired) {
      const activeFields = await this.listFields(orgId, true);
      const providedIds = new Set(values.map((v) => v.fieldId));
      const missingRequired = activeFields.filter((f) => f.required && !providedIds.has(f.id));
      if (missingRequired.length > 0) {
        throw new ConflictException(
          `Missing required field(s): ${missingRequired.map((f) => f.label).join(", ")}`,
        );
      }
    }

    for (const value of values) {
      if (!fieldById.has(value.fieldId)) continue;
      await this.db
        .insert(supportTicketCustomFieldValues)
        .values({ orgId, ticketId, fieldId: value.fieldId, value: value.value })
        .onConflictDoUpdate({
          target: [supportTicketCustomFieldValues.ticketId, supportTicketCustomFieldValues.fieldId],
          set: { value: value.value, updatedAt: new Date() },
        });
    }
  }
}
