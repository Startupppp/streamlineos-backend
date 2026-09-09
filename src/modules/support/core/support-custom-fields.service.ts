import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { customFieldDefinitions } from "../../../db/schema/custom-field-engine";
import { supportTicketCustomFieldValues } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { getPostgresErrorCode } from "../../../common/db/postgres-error";
import type { CreateCustomFieldInput, CustomFieldValueInput, UpdateCustomFieldInput } from "./dto/support.schemas";

const SUPPORT_ENTITY_TYPE = "support_ticket" as const;

type SupportFieldShape = {
  id: number;
  orgId: string;
  key: string;
  label: string;
  fieldType: string;
  options: string[] | null | undefined;
  required: boolean;
  category: string | null | undefined;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class SupportCustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private toSupportField(
    def: typeof customFieldDefinitions.$inferSelect,
  ): SupportFieldShape {
    return {
      id: def.id,
      orgId: def.orgId,
      key: def.key,
      label: def.label,
      fieldType: def.fieldType,
      options: def.options?.map((o) => o.value),
      required: def.isRequired,
      category: def.category,
      sortOrder: def.displayOrder,
      isActive: def.isActive,
      createdAt: def.createdAt,
      updatedAt: def.updatedAt,
    };
  }

  async listFields(orgId: string, activeOnly = false) {
    const rows = await this.db
      .select()
      .from(customFieldDefinitions)
      .where(
        activeOnly
          ? and(
              eq(customFieldDefinitions.orgId, orgId),
              eq(customFieldDefinitions.entityType, SUPPORT_ENTITY_TYPE),
              eq(customFieldDefinitions.isActive, true),
            )
          : and(
              eq(customFieldDefinitions.orgId, orgId),
              eq(customFieldDefinitions.entityType, SUPPORT_ENTITY_TYPE),
            ),
      )
      .orderBy(asc(customFieldDefinitions.displayOrder), asc(customFieldDefinitions.id));
    return rows.map((r) => this.toSupportField(r));
  }

  async createField(orgId: string, input: CreateCustomFieldInput) {
    const [existing] = await this.db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, SUPPORT_ENTITY_TYPE),
          eq(customFieldDefinitions.key, input.key),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ConflictException(`A custom field with key "${input.key}" already exists`);
    }

    const [field] = await this.db
      .insert(customFieldDefinitions)
      .values({
        orgId,
        entityType: SUPPORT_ENTITY_TYPE,
        projectId: 0,
        key: input.key,
        label: input.label,
        fieldType: input.fieldType,
        options:
          input.fieldType === "select"
            ? (input.options ?? []).map((v) => ({ label: v, value: v }))
            : null,
        isRequired: input.required,
        category: input.category ?? null,
        displayOrder: input.sortOrder,
        isActive: input.isActive,
      })
      .returning()
      .catch((e: unknown) => {
        /**
         * `uniq_cfd_org_entity_project_key` — (org_id, entity_type,
         * project_id, key), every column non-null and this path's own values.
         * The check above is a read followed by a write, so the index answers
         * when two requests pass that check together — and it never did,
         * because Drizzle keeps the SQLSTATE on `.cause` and `e.code` off the
         * wrapper is undefined. The loser got a 500.
         */
        if (getPostgresErrorCode(e) === "23505") {
          throw new ConflictException(`A custom field with key "${input.key}" already exists`);
        }
        throw e;
      });
    if (!field) throw new ConflictException("Failed to create custom field");
    return this.toSupportField(field);
  }

  async updateField(orgId: string, fieldId: number, input: UpdateCustomFieldInput) {
    const [updated] = await this.db
      .update(customFieldDefinitions)
      .set({
        label: input.label,
        options:
          input.options !== undefined
            ? input.options.map((v) => ({ label: v, value: v }))
            : undefined,
        isRequired: input.required,
        category: input.category,
        displayOrder: input.sortOrder,
        isActive: input.isActive,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customFieldDefinitions.id, fieldId),
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, SUPPORT_ENTITY_TYPE),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Custom field not found");
    return this.toSupportField(updated);
  }

  async deleteField(orgId: string, fieldId: number) {
    const [deleted] = await this.db
      .delete(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.id, fieldId),
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, SUPPORT_ENTITY_TYPE),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Custom field not found");
    return { success: true };
  }

  async getFieldValues(orgId: string, ticketId: number) {
    return this.db
      .select({
        fieldId: supportTicketCustomFieldValues.fieldDefinitionId,
        value: supportTicketCustomFieldValues.value,
        key: customFieldDefinitions.key,
        label: customFieldDefinitions.label,
        fieldType: customFieldDefinitions.fieldType,
      })
      .from(supportTicketCustomFieldValues)
      .innerJoin(
        customFieldDefinitions,
        eq(customFieldDefinitions.id, supportTicketCustomFieldValues.fieldDefinitionId),
      )
      .where(
        and(
          eq(supportTicketCustomFieldValues.orgId, orgId),
          eq(supportTicketCustomFieldValues.ticketId, ticketId),
        ),
      );
  }

  async setFieldValues(
    orgId: string,
    ticketId: number,
    values: CustomFieldValueInput[],
    enforceRequired: boolean,
  ) {
    if (values.length === 0 && !enforceRequired) return;

    const fieldIds = values.map((v) => v.fieldId);
    const fields =
      fieldIds.length > 0
        ? await this.db
            .select()
            .from(customFieldDefinitions)
            .where(
              and(
                eq(customFieldDefinitions.orgId, orgId),
                eq(customFieldDefinitions.entityType, SUPPORT_ENTITY_TYPE),
                inArray(customFieldDefinitions.id, fieldIds),
              ),
            )
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

    const upsertRows = values
      .filter((v) => fieldById.has(v.fieldId))
      .map((v) => ({ orgId, ticketId, fieldDefinitionId: v.fieldId, value: v.value }));

    if (upsertRows.length === 0) return;

    await this.db
      .insert(supportTicketCustomFieldValues)
      .values(upsertRows)
      .onConflictDoUpdate({
        target: [
          supportTicketCustomFieldValues.ticketId,
          supportTicketCustomFieldValues.fieldDefinitionId,
        ],
        set: { value: sql`excluded.value`, updatedAt: new Date() },
      });
  }
}
