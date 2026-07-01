import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { customStates, projectMembers, ticketAssignees, ticketLabels, tickets, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  AddMemberInput,
  CreateLabelInput,
  CreateStateInput,
  UpdateLabelInput,
  UpdateCustomStateInput,
} from "./dto/projects.schemas";

@Injectable()
export class ProjectsMembersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listMembers(projectId: number) {
    return this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        image: users.image,
        email: users.email,
        role: projectMembers.role,
        joinedAt: projectMembers.joinedAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .where(eq(projectMembers.projectId, projectId));
  }

  async addMember(projectId: number, body: AddMemberInput) {
    const existing = await this.db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, body.userId)),
    });
    if (existing) throw new ConflictException("User is already a project member");

    const [member] = await this.db
      .insert(projectMembers)
      .values({ projectId, userId: body.userId, role: body.role })
      .returning();
    return member;
  }

  async removeMember(projectId: number, userId: string) {
    await this.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));

    await this.db
      .update(tickets)
      .set({ assigneeId: null })
      .where(
        and(
          eq(tickets.projectId, projectId),
          eq(tickets.assigneeId, userId),
          ne(tickets.status, "DONE"),
          ne(tickets.status, "CANCELLED"),
        ),
      );

    const projectTicketIds = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.projectId, projectId),
          ne(tickets.status, "DONE"),
          ne(tickets.status, "CANCELLED"),
        ),
      );

    if (projectTicketIds.length > 0) {
      const ids = projectTicketIds.map((t) => t.id);
      await this.db
        .delete(ticketAssignees)
        .where(and(eq(ticketAssignees.userId, userId), inArray(ticketAssignees.ticketId, ids)));
    }

    return { success: true };
  }

  listCustomStates(orgId: string, projectId: number) {
    return this.db
      .select()
      .from(customStates)
      .where(and(eq(customStates.projectId, projectId), eq(customStates.orgId, orgId)))
      .orderBy(customStates.sequence);
  }

  async createCustomState(orgId: string, projectId: number, body: CreateStateInput) {
    const [state] = await this.db
      .insert(customStates)
      .values({
        projectId,
        orgId,
        name: body.name,
        color: body.color,
        group: body.group,
        sequence: body.sequence,
        isDefault: body.isDefault,
      })
      .returning();
    return state;
  }

  listLabels(orgId: string) {
    return this.db.query.ticketLabels.findMany({
      where: eq(ticketLabels.orgId, orgId),
      orderBy: [desc(ticketLabels.createdAt)],
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

  async updateCustomState(orgId: string, stateId: number, data: UpdateCustomStateInput) {
    const [updated] = await this.db
      .update(customStates)
      .set(data)
      .where(and(eq(customStates.id, stateId), eq(customStates.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("State not found");
    return updated;
  }

  async deleteCustomState(orgId: string, stateId: number) {
    const [deleted] = await this.db
      .delete(customStates)
      .where(and(eq(customStates.id, stateId), eq(customStates.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("State not found");
    return { success: true };
  }
}
