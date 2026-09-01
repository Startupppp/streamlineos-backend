import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import {
  projectMembers,
  organizationMembers,
  projects,
  ticketActivityLog,
  tickets,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  EntityActionResult,
  EntityActor,
  EntityReference,
} from "../../entity-reference/entity-reference.types";
import { resolveValidTicketStatuses } from "../core/ticket-status.util";

const TICKET_TYPES = ["TASK", "BUG"] as const;
type TicketType = (typeof TICKET_TYPES)[number];

type TicketActivityAction =
  | "status_changed"
  | "assignee_changed"
  | "due_date_changed";

function isTicketType(value: string): value is TicketType {
  return (TICKET_TYPES as readonly string[]).includes(value);
}

function text(input: Record<string, unknown>, name: string): string | null {
  const value = input[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

@Injectable()
export class BuildEntityActions {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async run(
    actor: EntityActor,
    reference: EntityReference,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult> {
    const id = Number(reference.id);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: "not-found" };

    if (reference.type === "project" && actionId === "create-ticket")
      return this.createTicket(actor, id, input);

    if (reference.type !== "ticket") return { ok: false, reason: "invalid" };

    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, id),
        eq(tickets.orgId, actor.orgId),
        isNull(tickets.deletedAt),
      ),
      columns: {
        id: true,
        status: true,
        assigneeMembershipId: true,
        dueDate: true,
        projectId: true,
      },
    });
    if (!ticket?.projectId) return { ok: false, reason: "not-found" };

    const allowed = await this.isProjectMember(actor, ticket.projectId);
    if (!allowed) return { ok: false, reason: "forbidden" };

    if (actionId === "status")
      return this.changeStatus(actor, ticket.id, ticket.projectId, ticket.status, input);
    if (actionId === "assign")
      return this.assign(actor, ticket.id, ticket.projectId, ticket.assigneeMembershipId, input);
    if (actionId === "due-date")
      return this.setDueDate(actor, ticket.id, ticket.projectId, ticket.dueDate, input);

    return { ok: false, reason: "invalid" };
  }

  private async isProjectMember(
    actor: EntityActor,
    projectId: number,
  ): Promise<boolean> {
    if (actor.isOrgOwner) return true;
    const membership = await this.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.membershipId, actor.membershipId ?? -1),
      ),
      columns: { projectId: true },
    });
    return Boolean(membership);
  }

  private async changeStatus(
    actor: EntityActor,
    ticketId: number,
    projectId: number,
    currentStatus: string,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult> {
    const nextStatus = text(input, "status");
    if (!nextStatus) return { ok: false, reason: "invalid" };

    if (currentStatus === nextStatus)
      return {
        ok: true,
        message: null,
        data: { prevStatus: currentStatus, nextStatus },
      };

    const valid = await resolveValidTicketStatuses(this.db, projectId, actor.orgId);
    if (!valid.has(nextStatus)) return { ok: false, reason: "invalid" };

    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, actor.orgId)));

      await this.logActivity(
        tx,
        actor,
        ticketId,
        "status_changed",
        currentStatus,
        nextStatus,
      );
    });
    this.audit.log({
      action: "ticket.status_changed",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(ticketId),
      targetType: "ticket",
      metadata: { projectId, from: currentStatus, to: nextStatus },
    });

    return {
      ok: true,
      message: `Status changed from ${currentStatus} to ${nextStatus}`,
      data: { prevStatus: currentStatus, nextStatus },
    };
  }

  private async assign(
    actor: EntityActor,
    ticketId: number,
    projectId: number,
    currentAssigneeId: number | null,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult> {
    const assigneeId = text(input, "assigneeId");
    if (!assigneeId) return { ok: false, reason: "invalid" };

    // The same set the action's declared option source offers. Without this,
    // submission accepted anyone the picker would never have shown - including
    // someone outside the project, who cannot open the ticket they were given.
    const targetActor = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, actor.orgId), eq(organizationMembers.userId, assigneeId), eq(organizationMembers.status, "ACTIVE")),
      columns: { id: true },
    });
    const assignable = targetActor && await this.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.orgId, actor.orgId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.membershipId, targetActor.id),
      ),
      columns: { projectId: true },
    });
    if (!assignable) return { ok: false, reason: "invalid" };

    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ assigneeMembershipId: targetActor.id, updatedAt: new Date() })
        .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, actor.orgId)));

      await this.logActivity(
        tx,
        actor,
        ticketId,
        "assignee_changed",
        currentAssigneeId === null ? null : String(currentAssigneeId),
        assigneeId,
      );
    });
    this.audit.log({
      action: "ticket.assignee_changed",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(ticketId),
      targetType: "ticket",
      metadata: { projectId, assigneeId },
    });

    return { ok: true, message: "Assignee updated", data: {} };
  }

  private async setDueDate(
    actor: EntityActor,
    ticketId: number,
    projectId: number,
    currentDueDate: string | null,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult> {
    const dueDate = text(input, "dueDate");
    if (!dueDate) return { ok: false, reason: "invalid" };

    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ dueDate, updatedAt: new Date() })
        .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, actor.orgId)));

      await this.logActivity(
        tx,
        actor,
        ticketId,
        "due_date_changed",
        currentDueDate,
        dueDate,
      );
    });
    this.audit.log({
      action: "ticket.due_date_changed",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(ticketId),
      targetType: "ticket",
      metadata: { projectId, dueDate },
    });

    return { ok: true, message: `Due date set to ${dueDate}`, data: {} };
  }

  private async createTicket(
    actor: EntityActor,
    projectId: number,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult> {
    const allowed = await this.isProjectMember(actor, projectId);
    if (!allowed) return { ok: false, reason: "forbidden" };

    const type = text(input, "type");
    if (!type || !isTicketType(type)) return { ok: false, reason: "invalid" };

    const project = await this.db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.orgId, actor.orgId),
        isNull(projects.deletedAt),
      ),
      columns: { key: true },
    });
    if (!project) return { ok: false, reason: "forbidden" };

    const description = text(input, "description") ?? "";
    const title = (text(input, "title") ?? description.slice(0, 80)).trim() || "Untitled";

    const created = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);

      const [maxRow] = await tx
        .select({ max: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, actor.orgId)));

      const [row] = await tx
        .insert(tickets)
        .values({
          orgId: actor.orgId,
          projectId,
          ticketNumber: (maxRow?.max ?? 0) + 1,
          title,
          description: description || null,
          type,
          status: "TODO",
          priority: "MEDIUM",
          reporterId: actor.userId,
        })
        .returning();

      return row;
    });

    if (!created) return { ok: false, reason: "invalid" };

    this.audit.log({
      action: "ticket.created_from_message",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(created.id),
      targetType: "ticket",
      metadata: { projectId, type },
    });

    return {
      ok: true,
      message: `Created ${type} ${project.key}-${created.ticketNumber}: ${created.title}`,
      data: {
        ticketId: created.id,
        ticketNumber: created.ticketNumber,
        projectKey: project.key,
        title: created.title,
        status: created.status,
      },
    };
  }

  private async logActivity(
    tx: TenantTx,
    actor: EntityActor,
    ticketId: number,
    action: TicketActivityAction,
    fromValue: string | null,
    toValue: string | null,
  ): Promise<void> {
    await tx.insert(ticketActivityLog).values({
      orgId: actor.orgId,
      ticketId,
      userMembershipId: actor.membershipId ?? null,
      action,
      fromValue,
      toValue,
    });
  }
}
