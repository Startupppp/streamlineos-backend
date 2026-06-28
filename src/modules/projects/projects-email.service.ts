import { Inject, Injectable } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { tickets, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";

@Injectable()
export class ProjectsEmailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  private async resolveActorName(actorId: string): Promise<string> {
    const actor = await this.db.query.users.findFirst({
      where: eq(users.id, actorId),
      columns: { name: true },
    });
    return actor?.name ?? "Team Member";
  }

  async notifyProjectMembers(
    creatorUserId: string,
    memberIds: string[],
    projectName: string,
    projectKey: string,
    projectId: number,
  ): Promise<void> {
    const ids = Array.from(new Set([...memberIds, creatorUserId]));
    const people = await this.db
      .select({ id: users.id, email: users.email, name: users.name, firstName: users.firstName })
      .from(users)
      .where(inArray(users.id, ids));

    const creator = people.find((p) => p.id === creatorUserId);
    const assignedBy = creator?.name || creator?.firstName || undefined;

    for (const memberId of memberIds) {
      const member = people.find((p) => p.id === memberId);
      if (!member?.email) continue;
      try {
        await this.email.sendProjectAssignmentEmail(
          member.email,
          member.name || member.firstName || "Team Member",
          projectName,
          projectKey,
          projectId,
          assignedBy,
        );
      } catch (error) {
        logger.error("Failed to send project assignment email", { error });
      }
    }
  }

  async notifyTicketAssignees(actingUserId: string, ticketId: number, assigneeIds: string[]): Promise<void> {
    const targets = assigneeIds.filter((id) => id !== actingUserId);
    if (targets.length === 0) return;

    const ticketData = await this.db.query.tickets.findFirst({
      where: eq(tickets.id, ticketId),
      columns: { title: true, projectId: true, type: true, priority: true },
      with: { project: { columns: { name: true } } },
    });
    if (!ticketData?.projectId) return;
    const projectId = ticketData.projectId;
    const [actorName, assigneeRows] = await Promise.all([
      this.resolveActorName(actingUserId),
      this.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(inArray(users.id, targets)),
    ]);
    const assigneeMap = new Map(assigneeRows.map((u) => [u.id, u]));

    for (const userId of targets) {
      const assignee = assigneeMap.get(userId);
      if (!assignee?.email) continue;
      await this.email.sendTicketAssignmentEmail(
        assignee.email,
        assignee.name ?? "Team Member",
        ticketData.title ?? `#${ticketId}`,
        ticketData.type ?? "TASK",
        ticketData.priority ?? "MEDIUM",
        ticketData.project?.name ?? "Project",
        projectId,
        ticketId,
        actorName,
      );
    }
  }

  async notifyStatusReview(
    ticketId: number,
    actingUserId: string,
    status: "IN_REVIEW" | "CHANGES_REQUESTED",
  ): Promise<void> {
    const ticketData = await this.db.query.tickets.findFirst({
      where: eq(tickets.id, ticketId),
      columns: { title: true, projectId: true, type: true, assigneeId: true, reporterId: true },
      with: { project: { columns: { name: true } } },
    });
    if (!ticketData?.projectId) return;
    const projectId = ticketData.projectId;
    const actorName = await this.resolveActorName(actingUserId);

    if (status === "IN_REVIEW" && ticketData.reporterId) {
      const reviewer = await this.db.query.users.findFirst({
        where: eq(users.id, ticketData.reporterId),
        columns: { email: true, name: true },
      });
      if (reviewer?.email) {
        await this.email.sendTicketReviewRequestEmail(
          reviewer.email,
          reviewer.name ?? "Reviewer",
          ticketData.title ?? `#${ticketId}`,
          ticketData.type ?? "TASK",
          ticketData.project?.name ?? "Project",
          projectId,
          ticketId,
          actorName,
        );
      }
    }

    if (status === "CHANGES_REQUESTED" && ticketData.assigneeId) {
      const assignee = await this.db.query.users.findFirst({
        where: eq(users.id, ticketData.assigneeId),
        columns: { email: true, name: true },
      });
      if (assignee?.email) {
        await this.email.sendTicketChangesRequestedEmail(
          assignee.email,
          assignee.name ?? "Team Member",
          ticketData.title ?? `#${ticketId}`,
          ticketData.project?.name ?? "Project",
          projectId,
          ticketId,
          actorName,
        );
      }
    }
  }
}
