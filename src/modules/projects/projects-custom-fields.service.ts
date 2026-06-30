import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  projectCustomFields,
  ticketCustomFieldValues,
  tickets,
} from "../../db/schema";
import type { CreateCustomFieldInput, UpdateCustomFieldInput, UpsertCustomFieldValuesInput } from "./dto/custom-fields.schemas";

@Injectable()
export class ProjectsCustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listFields(orgId: string, projectId: number) {
    return this.db.query.projectCustomFields.findMany({
      where: and(eq(projectCustomFields.projectId, projectId), eq(projectCustomFields.orgId, orgId)),
      orderBy: (f, { asc }) => [asc(f.position)],
    });
  }

  async createField(orgId: string, projectId: number, data: CreateCustomFieldInput) {
    const [field] = await this.db.insert(projectCustomFields).values({
      orgId,
      projectId,
      ...data,
    }).returning();
    return field;
  }

  async updateField(orgId: string, fieldId: number, data: UpdateCustomFieldInput) {
    const [updated] = await this.db.update(projectCustomFields)
      .set(data)
      .where(and(eq(projectCustomFields.id, fieldId), eq(projectCustomFields.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Custom field not found");
    return updated;
  }

  async deleteField(orgId: string, fieldId: number) {
    const [deleted] = await this.db.delete(projectCustomFields)
      .where(and(eq(projectCustomFields.id, fieldId), eq(projectCustomFields.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Custom field not found");
    return { success: true };
  }

  async getTicketValues(orgId: string, projectId: number, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    return this.db.query.ticketCustomFieldValues.findMany({
      where: eq(ticketCustomFieldValues.ticketId, ticketId),
      with: { field: true },
    });
  }

  async upsertTicketValues(orgId: string, projectId: number, ticketId: number, data: UpsertCustomFieldValuesInput) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    for (const { fieldId, value } of data.values) {
      await this.db.insert(ticketCustomFieldValues)
        .values({ ticketId, fieldId, value: value ?? null })
        .onConflictDoUpdate({
          target: [ticketCustomFieldValues.ticketId, ticketCustomFieldValues.fieldId],
          set: { value: value ?? null },
        });
    }
    return { success: true };
  }
}
