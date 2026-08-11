import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateEpicInput, UpdateEpicInput } from "./dto/iterations.schemas";

@Injectable()
export class EpicsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listEpics(orgId: string, projectId: number) {
    return this.db.query.tickets.findMany({
      where: and(
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.type, "EPIC"),
      ),
      columns: {
        completionPercentage: false,
        clientVisible: false,
        isRecurring: false,
        recurrenceRule: false,
        recurrenceParentId: false,
        recurrenceNextRunAt: false,
      },
      with: {
        assignee: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            image: true,
          },
        },
      },
      orderBy: [desc(tickets.createdAt)],
      limit: 100,
    });
  }

  async createEpic(orgId: string, userId: string, projectId: number, input: CreateEpicInput) {
    const [epic] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);

      const maxResult = await tx
        .select({ maxTicketNumber: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));

      const nextNumber = (maxResult[0]?.maxTicketNumber || 0) + 1;

      return tx
        .insert(tickets)
        .values({
          orgId,
          projectId,
          ticketNumber: nextNumber,
          title: input.title,
          description: input.description,
          type: "EPIC",
          priority: input.priority ?? "MEDIUM",
          assigneeId: input.assigneeId,
          reporterId: userId,
          points: input.points,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          status: "TODO",
        })
        .returning();
    });

    return epic;
  }

  async updateEpic(orgId: string, projectId: number, epicId: number, input: UpdateEpicInput) {
    const [updated] = await this.db
      .update(tickets)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(tickets.id, epicId),
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          eq(tickets.type, "EPIC"),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Epic not found");
    return updated;
  }

  async deleteEpic(orgId: string, projectId: number, epicId: number) {
    const epic = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, epicId),
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.type, "EPIC"),
      ),
      columns: { id: true },
    });
    if (!epic) throw new NotFoundException("Epic not found");
    await this.db.transaction(async (tx) => {
      await tx.update(tickets).set({ epicId: null }).where(and(eq(tickets.epicId, epicId), eq(tickets.orgId, orgId)));
      await tx.delete(tickets).where(and(eq(tickets.id, epicId), eq(tickets.orgId, orgId)));
    });
    return { success: true };
  }
}
