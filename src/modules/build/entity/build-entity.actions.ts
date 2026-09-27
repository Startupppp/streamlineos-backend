import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import {
  projectMembers,
  organizationMembers,
  ticketActivityLog,
  tickets,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  EntityActionResult,
  EntityActor,
  EntityReference,
} from "../../entity-reference/entity-reference.types";
import { resolveValidTicketStatuses } from "../core/tickets/ticket-status.util";
import { isProjectMember, text } from "./build-entity-action-helpers";
import { createTicketFromAction } from "./build-entity-ticket-create";
import { reserveTicketCapacity } from "../core/tickets/build-ticket-capacity";
import { CacheService } from "../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";

type TicketActivityAction =
  | "status_changed"
  | "assignee_changed"
  | "due_date_changed";

@Injectable()
export class BuildEntityActions {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async run(
    actor: EntityActor,
    reference: EntityReference,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult> {
    const id = Number(reference.id);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: "not-found" };

    if (reference.type === "project" && actionId === "create-ticket") {
      const result = await createTicketFromAction(this.db, this.audit, actor, id, input);
      if (result.ok)
        await this.cache
          .invalidateNamespace(`build:analytics:${actor.orgId}`)
          .catch(logSideEffectFailure("analytics cache eviction", { orgId: actor.orgId, projectId: id }));
      return result;
    }

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

    const allowed = await isProjectMember(this.db, actor, ticket.projectId);
    if (!allowed) return { ok: false, reason: "forbidden" };

    const result = actionId === "status"
      ? await this.changeStatus(actor, ticket.id, ticket.projectId, ticket.status, input)
      : actionId === "assign"
        ? await this.assign(actor, ticket.id, ticket.projectId, ticket.assigneeMembershipId, input)
        : actionId === "due-date"
          ? await this.setDueDate(actor, ticket.id, ticket.projectId, ticket.dueDate, input)
          : { ok: false as const, reason: "invalid" as const };
    if (result.ok)
      await this.cache
        .invalidateNamespace(`build:analytics:${actor.orgId}`)
        .catch(logSideEffectFailure("analytics cache eviction", { orgId: actor.orgId, projectId: ticket.projectId }));
    return result;
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
      await reserveTicketCapacity(tx, actor.orgId, projectId, [{ status: nextStatus, count: 1 }], [ticketId]);
      await tx
        .update(tickets)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, actor.orgId)));

      await this.logActivity(
        tx,
        actor,
        ticketId,
        projectId,
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
        projectId,
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
        projectId,
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

  private async logActivity(
    tx: TenantTx,
    actor: EntityActor,
    ticketId: number,
    projectId: number,
    action: TicketActivityAction,
    fromValue: string | null,
    toValue: string | null,
  ): Promise<void> {
    await tx.insert(ticketActivityLog).values({
      orgId: actor.orgId,
      ticketId,
      projectId,
      userMembershipId: actor.membershipId ?? null,
      action,
      fromValue,
      toValue,
    });
  }
}
