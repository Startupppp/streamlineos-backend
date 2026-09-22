import { Injectable, Inject, NotFoundException, ConflictException } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { customFieldDefinitions } from "../../../db/schema/custom-field-engine";
import { ticketCustomFieldValues, tickets } from "../../../db/schema";
import type { CreateCustomFieldInput, UpdateCustomFieldInput, UpsertCustomFieldValuesInput } from "./dto/custom-fields.schemas";
import { assertProjectInOrg } from "./project-access";
import { isUniqueViolation } from "../../../common/db/postgres-error";

const BUILD_ENTITY_TYPE = "build_ticket" as const;

type BuildFieldShape = {
  id: number;
  orgId: string;
  projectId: number;
  name: string;
  type: string;
  options: string[] | null;
  required: boolean;
  position: number;
  createdAt: Date;
};

@Injectable()
export class ProjectsCustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private toBuildField(
    def: typeof customFieldDefinitions.$inferSelect,
  ): BuildFieldShape {
    return {
      id: def.id,
      orgId: def.orgId,
      projectId: def.projectId,
      name: def.label,
      type: def.fieldType,
      options: def.options?.map((o) => o.value) ?? null,
      required: def.isRequired,
      position: def.displayOrder,
      createdAt: def.createdAt,
    };
  }

  async listFields(orgId: string, projectId: number) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const rows = await this.db
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, BUILD_ENTITY_TYPE),
          eq(customFieldDefinitions.projectId, projectId),
        ),
      )
      .orderBy(asc(customFieldDefinitions.displayOrder), asc(customFieldDefinitions.id));
    return rows.map((r) => this.toBuildField(r));
  }

  async createField(orgId: string, projectId: number, data: CreateCustomFieldInput) {
    // `listFields` above already resolves the project. Without the same assertion here the row
    // landed under the caller's own organisation carrying ANOTHER organisation's project id —
    // 201 where the contract requires 404, and a definition addressed to a project that is not
    // the tenant's.
    await assertProjectInOrg(this.db, orgId, projectId);
    const [field] = await this.db
      .insert(customFieldDefinitions)
      .values({
        orgId,
        entityType: BUILD_ENTITY_TYPE,
        projectId,
        key: data.name,
        label: data.name,
        fieldType: data.type,
        options: data.options
          ? data.options.map((v) => ({ label: v, value: v }))
          : null,
        isRequired: data.required,
        displayOrder: data.position,
        isActive: true,
      })
      .returning()
      .catch((e: unknown) => {
        if (isUniqueViolation(e)) {
          throw new ConflictException(`A custom field named "${data.name}" already exists in this project`);
        }
        throw e;
      });
    if (!field) throw new ConflictException("Failed to create custom field");
    return this.toBuildField(field);
  }

  async updateField(orgId: string, projectId: number, fieldId: number, data: UpdateCustomFieldInput) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const [updated] = await this.db
      .update(customFieldDefinitions)
      .set({
        label: data.name,
        key: data.name,
        fieldType: data.type,
        options:
          data.options !== undefined
            ? (data.options ?? []).map((v) => ({ label: v, value: v }))
            : undefined,
        isRequired: data.required,
        displayOrder: data.position,
      })
      .where(
        and(
          eq(customFieldDefinitions.id, fieldId),
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, BUILD_ENTITY_TYPE),
          eq(customFieldDefinitions.projectId, projectId),
        ),
      )
      .returning()
      .catch((e: unknown) => {
        if (isUniqueViolation(e)) {
          throw new ConflictException(`A custom field with this name already exists in the project`);
        }
        throw e;
      });
    if (!updated) throw new NotFoundException("Custom field not found");
    return this.toBuildField(updated);
  }

  async deleteField(orgId: string, projectId: number, fieldId: number) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const [deleted] = await this.db
      .delete(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.id, fieldId),
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, BUILD_ENTITY_TYPE),
          eq(customFieldDefinitions.projectId, projectId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Custom field not found");
    return { success: true };
  }

  async getTicketValues(orgId: string, projectId: number, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const rows = await this.db
      .select({
        id: ticketCustomFieldValues.id,
        orgId: ticketCustomFieldValues.orgId,
        ticketId: ticketCustomFieldValues.ticketId,
        fieldId: ticketCustomFieldValues.fieldDefinitionId,
        value: ticketCustomFieldValues.value,
        createdAt: ticketCustomFieldValues.createdAt,
        updatedAt: ticketCustomFieldValues.updatedAt,
        fieldDefId: customFieldDefinitions.id,
        fieldOrgId: customFieldDefinitions.orgId,
        fieldProjectId: customFieldDefinitions.projectId,
        fieldName: customFieldDefinitions.label,
        fieldType: customFieldDefinitions.fieldType,
        fieldOptions: customFieldDefinitions.options,
        fieldRequired: customFieldDefinitions.isRequired,
        fieldPosition: customFieldDefinitions.displayOrder,
        fieldCreatedAt: customFieldDefinitions.createdAt,
      })
      .from(ticketCustomFieldValues)
      .innerJoin(
        customFieldDefinitions,
        eq(customFieldDefinitions.id, ticketCustomFieldValues.fieldDefinitionId),
      )
      .where(
        and(
          eq(ticketCustomFieldValues.ticketId, ticketId),
          eq(ticketCustomFieldValues.orgId, orgId),
        ),
      );

    return rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      ticketId: row.ticketId,
      fieldId: row.fieldId,
      value: row.value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      field: {
        id: row.fieldDefId,
        orgId: row.fieldOrgId,
        projectId: row.fieldProjectId,
        name: row.fieldName,
        type: row.fieldType,
        options: row.fieldOptions?.map((o) => o.value) ?? null,
        required: row.fieldRequired,
        position: row.fieldPosition,
        createdAt: row.fieldCreatedAt,
      },
    }));
  }

  async upsertTicketValues(
    orgId: string,
    projectId: number,
    ticketId: number,
    data: UpsertCustomFieldValuesInput,
  ) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    if (data.values.length === 0) return { success: true };

    await this.db
      .insert(ticketCustomFieldValues)
      .values(
        data.values.map(({ fieldId, value }) => ({
          orgId,
          ticketId,
          fieldDefinitionId: fieldId,
          value: value ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [
          ticketCustomFieldValues.ticketId,
          ticketCustomFieldValues.fieldDefinitionId,
        ],
        set: { value: sql`excluded.value`, updatedAt: new Date() },
      });

    return { success: true };
  }
}
