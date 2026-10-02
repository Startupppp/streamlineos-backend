import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { and, eq, isNull } from "drizzle-orm";
import { projectAutomations, ticketLabels, tickets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { systemActor } from "../../../../common/auth/system-actor";
import type { UpdateTicketInput } from "../dto/ticket.schemas";
import { ProjectsTicketLabelsService } from "../tickets/projects-ticket-labels.service";
import { ProjectsTicketCommentsService } from "../tickets/projects-ticket-comments.service";

export type StoredAction = NonNullable<typeof projectAutomations.$inferSelect>["actions"][number];

export const AUTOMATION_TICKET_CHANGE = Symbol("AUTOMATION_TICKET_CHANGE");

export interface AutomationTicketChange {
  updateTicket(
    u: CurrentUserContext,
    projectId: number | null,
    ticketId: number,
    input: UpdateTicketInput,
  ): Promise<unknown>;
}

function isTicketPriority(value: string): value is "LOW" | "MEDIUM" | "HIGH" | "URGENT" {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH" || value === "URGENT";
}

function labelIdRef(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

@Injectable()
export class BuildAutomationActionExecutor {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly moduleRef: ModuleRef,
    private readonly labels: ProjectsTicketLabelsService,
    private readonly comments: ProjectsTicketCommentsService,
  ) {}

  private ticketChange(): AutomationTicketChange {
    return this.moduleRef.get<AutomationTicketChange>(AUTOMATION_TICKET_CHANGE, { strict: false });
  }

  private async changeTicket(
    actor: CurrentUserContext,
    projectId: number,
    ticketId: number,
    change: Omit<UpdateTicketInput, "version">,
  ): Promise<void> {
    const [current] = await this.db
      .select({ version: tickets.version })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, actor.orgId),
          eq(tickets.projectId, projectId),
          eq(tickets.id, ticketId),
          isNull(tickets.deletedAt),
        ),
      )
      .limit(1);
    if (!current) throw new NotFoundException("Ticket not found");
    await this.ticketChange().updateTicket(actor, projectId, ticketId, { ...change, version: current.version });
  }

  private async resolveLabelId(orgId: string, labelRef: string): Promise<number> {
    const byId = labelIdRef(labelRef);
    const [label] = await this.db
      .select({ id: ticketLabels.id })
      .from(ticketLabels)
      .where(
        and(
          eq(ticketLabels.orgId, orgId),
          byId === null ? eq(ticketLabels.name, labelRef) : eq(ticketLabels.id, byId),
        ),
      )
      .limit(1);
    if (!label) throw new NotFoundException(`Label "${labelRef}" not found`);
    return label.id;
  }

  async execute(
    orgId: string,
    projectId: number,
    ticketId: number,
    action: StoredAction,
    authorId: string | null,
  ): Promise<void> {
    const actor = systemActor("build.automation.apply-action", orgId, authorId ?? undefined);
    switch (action.type) {
      case "set_status":
        await this.changeTicket(actor, projectId, ticketId, { status: action.value });
        return;
      case "set_priority":
        if (!isTicketPriority(action.value))
          throw new BadRequestException(`Invalid priority "${action.value}"`);
        await this.changeTicket(actor, projectId, ticketId, { priority: action.value });
        return;
      case "set_assignee":
        await this.changeTicket(actor, projectId, ticketId, { assigneeId: action.value });
        return;
      case "add_label":
        await this.labels.addTicketLabel(actor, projectId, ticketId, {
          labelId: await this.resolveLabelId(orgId, action.value),
        });
        return;
      case "add_comment":
        if (!authorId) throw new BadRequestException("Automation rule has no author to post the comment as");
        await this.comments.addComment(actor, projectId, ticketId, { content: action.value });
        return;
    }
  }
}
