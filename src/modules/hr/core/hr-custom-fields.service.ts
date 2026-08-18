import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { customFieldDefinitions } from "../../../db/schema/custom-field-engine";
import { hrEmploymentCustomFieldValues } from "../../../db/schema/hr/core-org";
import { hrEmployments, hrPeople } from "../../../db/schema/hr/core-people";
import { organizationMembers } from "../../../db/schema";
import type { CreateCustomFieldInput, UpdateCustomFieldInput, UpsertCustomFieldValuesInput } from "./dto/hr-custom-fields.schemas";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import { assertActiveOrgUnit } from "../../../common/org/sync-org-unit-placement";

type HrFieldDef = {
  id: number;
  orgId: string;
  entityType: string;
  name: string;
  key: string;
  fieldType: string;
  options: Array<{ label: string; value: string }> | null | undefined;
  settings: typeof customFieldDefinitions.$inferSelect["settings"];
  isSensitive: boolean;
  isRequired: boolean;
  isActive: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class HrCustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private toHrFieldDef(row: typeof customFieldDefinitions.$inferSelect): HrFieldDef {
    return {
      id: row.id,
      orgId: row.orgId,
      entityType: row.entityType,
      name: row.label,
      key: row.key,
      fieldType: row.fieldType,
      options: row.options,
      settings: row.settings,
      isSensitive: row.isSensitive,
      isRequired: row.isRequired,
      isActive: row.isActive,
      displayOrder: row.displayOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async loadDefinition(orgId: string, id: number): Promise<HrFieldDef> {
    const [row] = await this.db
      .select()
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Custom field definition not found");
    return this.toHrFieldDef(row);
  }

  private async assertEmploymentInScope(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
    employmentId: number,
  ): Promise<void> {
    const [employment] = await this.db
      .select({ id: hrEmployments.id })
      .from(hrEmployments)
      .innerJoin(
        hrPeople,
        and(eq(hrPeople.orgId, hrEmployments.orgId), eq(hrPeople.id, hrEmployments.personId)),
      )
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
          isNull(hrPeople.deletedAt),
          applyScope(scope, orgId, actorUserId, { ownerColumn: hrPeople.userId }),
        ),
      )
      .limit(1);
    if (!employment) throw new NotFoundException("Employee not found");
  }

  private assertSupportedValueEntity(entityType: string): void {
    if (entityType !== "employee") {
      throw new BadRequestException(
        "Values are currently supported only for employee custom fields.",
      );
    }
  }

  async listDefinitions(orgId: string, entityType: string) {
    const rows = await this.db
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, entityType),
          eq(customFieldDefinitions.isActive, true),
        ),
      )
      .orderBy(asc(customFieldDefinitions.displayOrder), asc(customFieldDefinitions.id));
    return rows.map((r) => this.toHrFieldDef(r));
  }

  async createDefinition(orgId: string, input: CreateCustomFieldInput) {
    const [row] = await this.db
      .insert(customFieldDefinitions)
      .values({
        orgId,
        entityType: input.entityType,
        projectId: 0,
        key: input.key,
        label: input.name,
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
    return this.toHrFieldDef(row);
  }

  async updateDefinition(orgId: string, id: number, input: UpdateCustomFieldInput) {
    await this.loadDefinition(orgId, id);
    const [row] = await this.db
      .update(customFieldDefinitions)
      .set({
        label: input.name,
        options: input.options,
        settings: input.settings,
        isSensitive: input.isSensitive,
        isRequired: input.isRequired,
        isActive: input.isActive,
        displayOrder: input.displayOrder,
      })
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Custom field definition not found");
    return this.toHrFieldDef(row);
  }

  async deleteDefinition(orgId: string, id: number) {
    await this.loadDefinition(orgId, id);
    await this.db
      .update(customFieldDefinitions)
      .set({ isActive: false })
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)));
  }

  async getEntityValues(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
    entityType: string,
    entityId: string,
    canViewSensitive: boolean,
  ) {
    this.assertSupportedValueEntity(entityType);
    const empId = Number(entityId);
    if (!Number.isInteger(empId) || empId <= 0) {
      throw new BadRequestException("Invalid entity ID — must be a positive integer");
    }

    await this.assertEmploymentInScope(orgId, actorUserId, scope, empId);
    const defs = await this.listDefinitions(orgId, entityType);
    const values = await this.db
      .select({
        fieldDefinitionId: hrEmploymentCustomFieldValues.fieldDefinitionId,
        value: hrEmploymentCustomFieldValues.value,
      })
      .from(hrEmploymentCustomFieldValues)
      .where(
        and(
          eq(hrEmploymentCustomFieldValues.orgId, orgId),
          eq(hrEmploymentCustomFieldValues.employmentId, empId),
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
    actorUserId: string,
    scope: DataScope,
    entityType: string,
    entityId: string,
    input: UpsertCustomFieldValuesInput,
    canManageSensitive: boolean,
  ) {
    this.assertSupportedValueEntity(entityType);
    const empId = Number(entityId);
    if (!Number.isInteger(empId) || empId <= 0) {
      throw new BadRequestException("Invalid entity ID — must be a positive integer");
    }

    await this.assertEmploymentInScope(orgId, actorUserId, scope, empId);
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
      await this.validateReferenceValue(orgId, def.fieldType, item.value);
    }

    const rows = input.values.map((item) => ({
      orgId,
      employmentId: empId,
      fieldDefinitionId: item.fieldDefinitionId,
      value: item.value,
    }));

    await this.db
      .insert(hrEmploymentCustomFieldValues)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          hrEmploymentCustomFieldValues.employmentId,
          hrEmploymentCustomFieldValues.fieldDefinitionId,
        ],
        set: {
          value: sql`excluded.value`,
          updatedAt: new Date(),
        },
      });
  }

  private async validateReferenceValue(
    orgId: string,
    fieldType: string,
    value: unknown,
  ): Promise<void> {
    if (value === null || value === undefined || value === "") return;
    if (fieldType === "department_ref") {
      if (typeof value !== "string") {
        throw new BadRequestException("Expected a department ID.");
      }
      await assertActiveOrgUnit(this.db, orgId, value, "DEPARTMENT");
    }
    if (fieldType === "employee_ref") {
      if (typeof value !== "string") {
        throw new BadRequestException("Expected an employee user ID.");
      }
      const [member] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, value),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(1);
      if (!member) throw new BadRequestException("Invalid employee selection.");
    }
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
