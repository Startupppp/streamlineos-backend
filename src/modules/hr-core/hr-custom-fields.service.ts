import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrCustomFieldDefinitions, hrCustomFieldValues } from "../../db/schema/hr/core-org";
import type { CreateCustomFieldInput, UpdateCustomFieldInput, UpsertCustomFieldValuesInput } from "./dto/hr-custom-fields.schemas";

type FieldDef = typeof hrCustomFieldDefinitions.$inferSelect;

@Injectable()
export class HrCustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async loadDefinition(orgId: string, id: number): Promise<FieldDef> {
    const [row] = await this.db
      .select()
      .from(hrCustomFieldDefinitions)
      .where(and(eq(hrCustomFieldDefinitions.id, id), eq(hrCustomFieldDefinitions.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Custom field definition not found");
    return row;
  }

  async listDefinitions(orgId: string, entityType: string) {
    return this.db
      .select()
      .from(hrCustomFieldDefinitions)
      .where(
        and(
          eq(hrCustomFieldDefinitions.orgId, orgId),
          eq(hrCustomFieldDefinitions.entityType, entityType),
          eq(hrCustomFieldDefinitions.isActive, true),
        ),
      )
      .orderBy(asc(hrCustomFieldDefinitions.displayOrder), asc(hrCustomFieldDefinitions.id));
  }

  async createDefinition(orgId: string, input: CreateCustomFieldInput) {
    const [row] = await this.db
      .insert(hrCustomFieldDefinitions)
      .values({
        orgId,
        entityType: input.entityType,
        name: input.name,
        key: input.key,
        fieldType: input.fieldType,
        options: input.options ?? null,
        settings: input.settings ?? null,
        isSensitive: input.isSensitive ?? false,
        isRequired: input.isRequired ?? false,
        isActive: true,
        displayOrder: input.displayOrder ?? 0,
      })
      .returning();
    if (!row) throw new BadRequestException("Failed to create custom field");
    return row;
  }

  async updateDefinition(orgId: string, id: number, input: UpdateCustomFieldInput) {
    await this.loadDefinition(orgId, id);
    const [row] = await this.db
      .update(hrCustomFieldDefinitions)
      .set({
        name: input.name,
        options: input.options,
        settings: input.settings,
        isSensitive: input.isSensitive,
        isRequired: input.isRequired,
        isActive: input.isActive,
        displayOrder: input.displayOrder,
      })
      .where(and(eq(hrCustomFieldDefinitions.id, id), eq(hrCustomFieldDefinitions.orgId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Custom field definition not found");
    return row;
  }

  async deleteDefinition(orgId: string, id: number) {
    await this.loadDefinition(orgId, id);
    await this.db
      .update(hrCustomFieldDefinitions)
      .set({ isActive: false })
      .where(and(eq(hrCustomFieldDefinitions.id, id), eq(hrCustomFieldDefinitions.orgId, orgId)));
  }

  async getEntityValues(
    orgId: string,
    entityType: string,
    entityId: string,
    canViewSensitive: boolean,
  ) {
    const defs = await this.listDefinitions(orgId, entityType);
    const values = await this.db
      .select({
        fieldDefinitionId: hrCustomFieldValues.fieldDefinitionId,
        value: hrCustomFieldValues.value,
      })
      .from(hrCustomFieldValues)
      .where(
        and(
          eq(hrCustomFieldValues.orgId, orgId),
          eq(hrCustomFieldValues.entityType, entityType),
          eq(hrCustomFieldValues.entityId, entityId),
        ),
      );

    const valueMap = new Map(values.map((v) => [v.fieldDefinitionId, v.value]));

    return defs.map((def) => {
      const rawValue = valueMap.get(def.id);
      return {
        definition: def,
        value: def.isSensitive && !canViewSensitive ? "[REDACTED]" : rawValue,
      };
    });
  }

  async upsertEntityValues(
    orgId: string,
    entityType: string,
    entityId: string,
    input: UpsertCustomFieldValuesInput,
    canManageSensitive: boolean,
  ) {
    const defs = await this.listDefinitions(orgId, entityType);
    const defMap = new Map(defs.map((d) => [d.id, d]));

    for (const item of input.values) {
      const def = defMap.get(item.fieldDefinitionId);
      if (!def) throw new BadRequestException(`Field ${item.fieldDefinitionId} not found`);
      if (def.orgId !== orgId) throw new ForbiddenException("Field does not belong to org");
      if (def.isSensitive && !canManageSensitive) {
        throw new ForbiddenException("Cannot update sensitive field without hr:sensitive:manage");
      }
      this.validateFieldValue(def.fieldType, item.value, def.isRequired);
    }

    const rows = input.values.map((item) => ({
      orgId,
      fieldDefinitionId: item.fieldDefinitionId,
      entityType,
      entityId,
      value: item.value,
    }));

    await this.db
      .insert(hrCustomFieldValues)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          hrCustomFieldValues.fieldDefinitionId,
          hrCustomFieldValues.entityType,
          hrCustomFieldValues.entityId,
        ],
        set: {
          value: sql`excluded.${sql.raw(hrCustomFieldValues.value.name)}`,
          updatedAt: new Date(),
        },
      });
  }

  private validateFieldValue(
    fieldType: string,
    value: unknown,
    isRequired: boolean,
  ): void {
    if (isRequired && (value === null || value === undefined || value === "")) {
      throw new BadRequestException("Required field value is missing");
    }
    if (value === null || value === undefined) return;
    if (fieldType === "number" || fieldType === "currency") {
      if (typeof value !== "number") throw new BadRequestException("Expected number value");
    }
    if (fieldType === "boolean") {
      if (typeof value !== "boolean") throw new BadRequestException("Expected boolean value");
    }
    if (fieldType === "date") {
      if (typeof value !== "string" || isNaN(Date.parse(value))) {
        throw new BadRequestException("Expected ISO date string");
      }
    }
  }
}
