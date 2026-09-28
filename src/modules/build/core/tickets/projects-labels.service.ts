import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { ticketLabels } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CreateLabelInput, UpdateLabelInput } from "../dto/projects.schemas";

@Injectable()
export class ProjectsLabelsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listLabels(orgId: string) {
    return this.db.query.ticketLabels.findMany({
      where: eq(ticketLabels.orgId, orgId),
      orderBy: [asc(ticketLabels.name)],
      limit: 300,
    });
  }

  async createLabel(orgId: string, body: CreateLabelInput) {
    const [label] = await this.db
      .insert(ticketLabels)
      .values({ orgId, name: body.name, color: body.color ?? "#3B82F6" })
      .returning();
    return label;
  }

  async updateLabel(orgId: string, labelId: number, data: UpdateLabelInput) {
    const [updated] = await this.db
      .update(ticketLabels)
      .set(data)
      .where(and(eq(ticketLabels.id, labelId), eq(ticketLabels.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Label not found");
    return updated;
  }

  async deleteLabel(orgId: string, labelId: number) {
    const [deleted] = await this.db
      .delete(ticketLabels)
      .where(and(eq(ticketLabels.id, labelId), eq(ticketLabels.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Label not found");
    return { success: true };
  }
}
