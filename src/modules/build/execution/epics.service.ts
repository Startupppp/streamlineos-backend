import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateEpicInput, UpdateEpicInput } from "./dto/iterations.schemas";
import { allocateTicketNumbers } from "../core/lib/allocate-ticket-number";
import { assertProjectInOrg } from "../core/project-access";
import { reserveTicketCapacity } from "../core/build-ticket-capacity";

@Injectable()
export class EpicsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listEpics(orgId: string, projectId: number) {
    await assertProjectInOrg(this.db, orgId, projectId);
    return this.db.query.tickets.findMany({
      where: and(
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.type, "EPIC"),
        isNull(tickets.deletedAt),
      ),
      with: {
        assignee: { with: { user: { columns: { id: true, name: true, firstName: true, lastName: true, email: true, image: true } } } },
      },
      orderBy: [desc(tickets.createdAt)],
      limit: 100,
    });
  }

  async createEpic(orgId: string, userId: string, projectId: number, input: CreateEpicInput) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const [epic] = await this.db.transaction(async (tx) => {
      await reserveTicketCapacity(tx, orgId, projectId, [{ status: "TODO", count: 1 }]);
      const nextNumber = await allocateTicketNumbers(tx, orgId, projectId);

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
          assigneeMembershipId: undefined,
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
          isNull(tickets.deletedAt),
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
        isNull(tickets.deletedAt),
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
