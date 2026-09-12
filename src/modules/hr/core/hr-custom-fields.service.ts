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
import { hrEmployments, hrPeople } from "../../../db/schema/hr/core-people";
import { organizationMembers } from "../../../db/schema";
import type { CreateCustomFieldInput, UpdateCustomFieldInput, UpsertCustomFieldValuesInput } from "./dto/hr-custom-fields.schemas";
import type { ScopedRead } from "../../access/scoped-read";
import { assertActiveOrgUnit } from "../../../common/org/sync-org-unit-placement";
import {
  type HrFieldDef,
  toHrFieldDef,
  validateFieldValue,
} from "./hr-custom-field-helpers";

@Injectable()
export class HrCustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async loadDefinition(orgId: string, id: number): Promise<HrFieldDef> {
    const [row] = await this.db
      .select()
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Custom field definition not found");
    return toHrFieldDef(row);
  }

  private async assertEmploymentInScope(
    read: ScopedRead,
    employmentId: number,
  ): Promise<void> {
    const [employment] = await read.read(
      {
        tenant: hrEmployments.orgId,
        scope: { columns: { ownerColumn: hrPeople.userId } },
        and: [
          eq(hrEmployments.id, employmentId),
          isNull(hrEmployments.deletedAt),
          isNull(hrPeople.deletedAt),
        ],
      },
      ({ sql: where }) =>
        this.db
          .select({ id: hrEmployments.id })
          .from(hrEmployments)
          .innerJoin(
            hrPeople,
            and(eq(hrPeople.orgId, hrEmployments.orgId), eq(hrPeople.id, hrEmployments.personId)),
          )
          .where(where)
          .limit(1),
      () => [],
    );
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
      .orderBy(asc(customFieldDefinitions.displayOrder), asc(customFieldDefinitions.id))
      .limit(100);
    return rows.map((r) => toHrFieldDef(r));
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
    return toHrFieldDef(row);
  }

  async updateDefinition(orgId: string, id: number, input: UpdateCustomFieldInput) {
    await this.loadDefinition(orgId, id);
    const [row] = await this.db
      .update(customFieldDefinitions)
      .set({
        updatedAt: new Date(),
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
    return toHrFieldDef(row);
  }

  async deleteDefinition(orgId: string, id: number) {
    await this.loadDefinition(orgId, id);
    await this.db
      .update(customFieldDefinitions)
      .set({ isActive: false })
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)));
  }

  async getEntityValues(
    read: ScopedRead,
    entityType: string,
    entityId: string,
    canViewSensitive: boolean,
  ) {
    const orgId = read.orgId;
    this.assertSupportedValueEntity(entityType);
    const empId = Number(entityId);
    if (!Number.isInteger(empId) || empId <= 0) {
      throw new BadRequestException("Invalid entity ID — must be a positive integer");
    }

    await this.assertEmploymentInScope(read, empId);

    const [defs, empRows] = await Promise.all([
      this.listDefinitions(orgId, entityType),
      this.db
        .select({ customFieldValues: hrEmployments.customFieldValues })
        .from(hrEmployments)
        .where(and(eq(hrEmployments.id, empId), eq(hrEmployments.orgId, orgId)))
        .limit(1),
    ]);

    const storedValues: Record<string, unknown> = empRows[0]?.customFieldValues ?? {};

    return defs.map((def) => {
      const hasKey = Object.prototype.hasOwnProperty.call(storedValues, def.key);
      const rawValue = hasKey ? storedValues[def.key] : undefined;
      return {
        definition: def,
        value: def.isSensitive && !canViewSensitive ? "[REDACTED]" : rawValue,
      };
    });
  }

  async upsertEntityValues(
    read: ScopedRead,
    entityType: string,
    entityId: string,
    input: UpsertCustomFieldValuesInput,
    canManageSensitive: boolean,
  ) {
    const orgId = read.orgId;
    this.assertSupportedValueEntity(entityType);
    const empId = Number(entityId);
    if (!Number.isInteger(empId) || empId <= 0) {
      throw new BadRequestException("Invalid entity ID — must be a positive integer");
    }

    await this.assertEmploymentInScope(read, empId);
    const defs = await this.listDefinitions(orgId, entityType);
    const defMap = new Map(defs.map((d) => [d.id, d]));

    const patch: Record<string, unknown> = {};
    for (const item of input.values) {
      const def = defMap.get(item.fieldDefinitionId);
      if (!def) throw new BadRequestException(`Field ${item.fieldDefinitionId} not found`);
      if (def.orgId !== orgId) throw new ForbiddenException("Field does not belong to org");
      if (def.isSensitive && !canManageSensitive) {
        throw new ForbiddenException("Cannot update sensitive field without hr:sensitive:manage");
      }
      validateFieldValue(def.fieldType, item.value, def.isRequired);
      await this.validateReferenceValue(orgId, def.fieldType, item.value);
      patch[def.key] = item.value;
    }

    await this.db
      .update(hrEmployments)
      .set({
        customFieldValues: sql`${hrEmployments.customFieldValues} || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(and(eq(hrEmployments.id, empId), eq(hrEmployments.orgId, orgId)));
  }

  async filterByCustomField(
    read: ScopedRead,
    entityType: string,
    fieldKey: string,
    value: unknown,
  ): Promise<number[]> {
    this.assertSupportedValueEntity(entityType);

    const fieldCondition =
      value === undefined
        ? sql`NOT (${hrEmployments.customFieldValues} ? ${fieldKey})`
        : sql`${hrEmployments.customFieldValues} @> ${JSON.stringify({ [fieldKey]: value })}::jsonb`;

    const rows = await read.read(
      {
        tenant: hrEmployments.orgId,
        scope: { columns: { ownerColumn: hrPeople.userId } },
        and: [isNull(hrEmployments.deletedAt), isNull(hrPeople.deletedAt), fieldCondition],
      },
      ({ sql: where }) =>
        this.db
          .select({ id: hrEmployments.id })
          .from(hrEmployments)
          .innerJoin(
            hrPeople,
            and(
              eq(hrPeople.orgId, hrEmployments.orgId),
              eq(hrPeople.id, hrEmployments.personId),
            ),
          )
          .where(where)
          .limit(100),
      () => [],
    );

    return rows.map((r) => r.id);
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
}
