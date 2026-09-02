import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { okrGoals, okrLinks, projects, tickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import type { CreateLinkInput } from "./dto/goal.schemas";

export interface GoalLinkRow {
  id: number;
  ticketId: number | null;
  projectId: number | null;
  createdAt: Date;
  ticketTitle: string | null;
  ticketProjectId: number | null;
  projectName: string | null;
  projectKey: string | null;
}

export type CreateLinkResult =
  | typeof okrLinks.$inferSelect
  | { error: "goal_not_found" }
  | { error: "ticket_not_found" }
  | { error: "project_not_found" };

export function isLinkGoalNotFound(
  result: CreateLinkResult,
): result is { error: "goal_not_found" } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    result.error === "goal_not_found"
  );
}

export function isLinkTicketNotFound(
  result: CreateLinkResult,
): result is { error: "ticket_not_found" } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    result.error === "ticket_not_found"
  );
}

export function isLinkProjectNotFound(
  result: CreateLinkResult,
): result is { error: "project_not_found" } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    result.error === "project_not_found"
  );
}

@Injectable()
export class GoalLinksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  getLinks(orgId: string, goalId: number): Promise<GoalLinkRow[]> {
    return this.db
      .select({
        id: okrLinks.id,
        ticketId: okrLinks.ticketId,
        projectId: okrLinks.projectId,
        createdAt: okrLinks.createdAt,
        ticketTitle: tickets.title,
        ticketProjectId: tickets.projectId,
        projectName: projects.name,
        projectKey: projects.key,
      })
      .from(okrLinks)
      .leftJoin(tickets, and(eq(okrLinks.ticketId, tickets.id), isNull(tickets.deletedAt)))
      .leftJoin(projects, and(eq(okrLinks.projectId, projects.id), isNull(projects.deletedAt)))
      .where(and(eq(okrLinks.goalId, goalId), eq(okrLinks.orgId, orgId)))
      .orderBy(desc(okrLinks.createdAt))
      .limit(100);
  }

  async createLink(orgId: string, goalId: number, input: CreateLinkInput): Promise<CreateLinkResult> {
    const goal = await this.db.query.okrGoals.findFirst({
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)),
      columns: { id: true },
    });
    if (!goal) return { error: "goal_not_found" as const };

    if (input.ticketId !== undefined) {
      const ticket = await this.db.query.tickets.findFirst({
        where: and(eq(tickets.id, input.ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)),
        columns: { id: true },
      });
      if (!ticket) return { error: "ticket_not_found" as const };
    }

    if (input.projectId !== undefined) {
      const project = await this.db.query.projects.findFirst({
        where: and(eq(projects.id, input.projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
        columns: { id: true },
      });
      if (!project) return { error: "project_not_found" as const };
    }

    const [link] = await this.db
      .insert(okrLinks)
      .values({
        orgId,
        goalId,
        ticketId: input.ticketId ?? null,
        projectId: input.projectId ?? null,
      })
      .returning();

    return link;
  }

  async removeLink(orgId: string, goalId: number, linkId: number): Promise<{ success: true } | null> {
    const [deleted] = await this.db
      .delete(okrLinks)
      .where(
        and(
          eq(okrLinks.id, linkId),
          eq(okrLinks.goalId, goalId),
          eq(okrLinks.orgId, orgId),
        ),
      )
      .returning();

    if (!deleted) return null;
    return { success: true };
  }
}
