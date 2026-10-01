import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
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
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ACCOUNT_ONLY_PRINCIPAL, humanSessionPrincipal } from "../../../common/auth/principal";
import type {
  EntityActionResult,
  EntityActor,
  EntityReference,
} from "../../entity-reference/entity-reference.types";
import {
  BuildTicketCreationService,
  ProjectsTicketsUpdateService,
  resolveValidTicketStatuses,
  TicketVersionConflictException,
} from "../core/tickets";
import { isProjectMember, text } from "./build-entity-action-helpers";
import { createTicketFromAction } from "./build-entity-ticket-create";
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
    private readonly ticketCreation: BuildTicketCreationService,
    private readonly ticketChange: ProjectsTicketsUpdateService,
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
      return createTicketFromAction(this.db, this.audit, this.ticketCreation, actor, id, input);
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
        version: true,
      },
    });
    if (!ticket?.projectId) return { ok: false, reason: "not-found" };

    const allowed = await isProjectMember(this.db, actor, ticket.projectId);
    if (!allowed) return { ok: false, reason: "forbidden" };

    const result = actionId === "status"
      ? await this.changeStatus(actor, ticket.id, ticket.projectId, ticket.status, input, ticket.version)
      : actionId === "assign"
        ? await this.assign(actor, ticket.id, ticket.projectId, input, ticket.version)
        : actionId === "due-date"
          ? await this.setDueDate(actor, ticket.id, ticket.projectId, ticket.dueDate, input)
          : { ok: false as const, reason: "invalid" as const };
    if (result.ok)
      await this.cache
        .invalidateNamespace(`build:analytics:${actor.orgId}`)
        .catch(logSideEffectFailure("analytics cache eviction", { orgId: actor.orgId, projectId: ticket.projectId }));
    return result;
  }

  private toUserContext(actor: EntityActor): CurrentUserContext {
    const principal = actor.membershipId !== undefined
      ? humanSessionPrincipal(actor.membershipId, actor.isOrgOwner)
      : ACCOUNT_ONLY_PRINCIPAL;
    return {
      userId: actor.userId,
      orgId: actor.orgId,
      role: actor.isOrgOwner ? "admin" : "member",
      isOrgOwner: actor.isOrgOwner,
      sessionId: `entity-action:${actor.userId}`,
      tokenScopes: null,
      principal,
    };
  }

  private async changeStatus(
    actor: EntityActor,
    ticketId: number,
    projectId: number,
    currentStatus: string,
    input: Record<string, unknown>,
    version: number,
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

    try {
      await this.ticketChange.updateTicket(
        this.toUserContext(actor),
        projectId,
        ticketId,
        { status: nextStatus, version },
      );
    } catch (error) {
      if (
        error instanceof TicketVersionConflictException ||
        error instanceof BadRequestException
      ) return { ok: false, reason: "invalid" };
      if (error instanceof ForbiddenException) return { ok: false, reason: "forbidden" };
      if (error instanceof NotFoundException) return { ok: false, reason: "not-found" };
      throw error;
    }

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
    input: Record<string, unknown>,
    version: number,
  ): Promise<EntityActionResult> {
    const assigneeId = text(input, "assigneeId");
    if (!assigneeId) return { ok: false, reason: "invalid" };

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

    try {
      await this.ticketChange.updateTicket(
        this.toUserContext(actor),
        projectId,
        ticketId,
        { assigneeId, version },
      );
    } catch (error) {
      if (
        error instanceof TicketVersionConflictException ||
        error instanceof BadRequestException
      ) return { ok: false, reason: "invalid" };
      if (error instanceof ForbiddenException) return { ok: false, reason: "forbidden" };
      if (error instanceof NotFoundException) return { ok: false, reason: "not-found" };
      throw error;
    }

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
