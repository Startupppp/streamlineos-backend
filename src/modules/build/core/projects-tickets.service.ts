import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  ticketAssignees,
  ticketAttachments,
  ticketComments,
  ticketLabelMappings,
  tickets,
  ticketWatchers,
  timesheets,
  workItemRelations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsWorkQueryService } from "./projects-work-query.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import { ProjectsTicketsDetailService } from "./projects-tickets-detail.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { ProjectsTicketsCreateService } from "./projects-tickets-create.service";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
import type {
  AllWorkQuery,
  BulkUpdateInput,
  CreateTicketInput,
  ImportTicketsInput,
  RankTicketInput,
  TicketsListQuery,
  UpdateTicketInput,
} from "./dto/projects.schemas";

@Injectable()
export class ProjectsTicketsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly query: ProjectsTicketsQueryService,
    private readonly workQuery: ProjectsWorkQueryService,
    private readonly read: ProjectsTicketsReadService,
    private readonly detail: ProjectsTicketsDetailService,
    private readonly transfer: ProjectsTicketsTransferService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly cache: CacheService,
    private readonly create: ProjectsTicketsCreateService,
    private readonly update: ProjectsTicketsUpdateService,
  ) {}

  async listTickets(
    u: CurrentUserContext,
    projectId: number,
    query: TicketsListQuery,
  ) {
    return this.read.listTickets(u, projectId, query);
  }

  async createTicket(
    u: CurrentUserContext,
    projectId: number,
    body: CreateTicketInput,
  ) {
    return this.create.createTicket(u, projectId, body);
  }

  async createFromFeedback(
    orgId: string,
    actingUserId: string,
    projectId: number,
    input: { title: string; description: string; type?: string },
  ): Promise<{ id: number }> {
    return this.create.createFromFeedback(orgId, actingUserId, projectId, input);
  }

  async getTicketByKey(u: CurrentUserContext, projectId: number, ticketNumber: number) {
    return this.detail.getTicketByKey(u, projectId, ticketNumber);
  }

  async getTicket(u: CurrentUserContext, ticketId: number) {
    return this.detail.getTicket(u, ticketId);
  }

  async updateTicket(
    u: CurrentUserContext,
    ticketId: number,
    input: UpdateTicketInput,
  ) {
    return this.update.updateTicket(u, ticketId, input);
  }

  async deleteTicket(
    orgId: string,
    userId: string,
    ticketId: number,
    force: boolean,
  ) {
    const existing = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)),
      columns: { id: true, projectId: true, title: true },
    });
    if (!existing || !existing.projectId)
      throw new NotFoundException("Ticket not found");

    const { hasAccess } = await this.read.checkProjectAccess(
      orgId,
      userId,
      existing.projectId,
    );
    if (!hasAccess)
      throw new ForbiddenException("Not authorized to delete this ticket");

    if (!force) {
      const blockedBy = await this.db.query.workItemRelations.findMany({
        where: and(
          eq(workItemRelations.relatedWorkItemId, ticketId),
          eq(workItemRelations.relationType, "blocks"),
        ),
        columns: { workItemId: true },
      });
      if (blockedBy.length > 0) {
        throw new ConflictException(
          `This ticket is blocked by ${blockedBy.length} other ticket(s). Add ?force=true to delete anyway.`,
        );
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ parentTicketId: null })
        .where(eq(tickets.parentTicketId, ticketId));
      await tx
        .update(tickets)
        .set({ epicId: null })
        .where(eq(tickets.epicId, ticketId));

      await tx
        .delete(ticketAssignees)
        .where(eq(ticketAssignees.ticketId, ticketId));
      await tx
        .delete(ticketComments)
        .where(eq(ticketComments.ticketId, ticketId));
      await tx
        .delete(ticketAttachments)
        .where(eq(ticketAttachments.ticketId, ticketId));
      await tx
        .delete(ticketLabelMappings)
        .where(eq(ticketLabelMappings.ticketId, ticketId));
      await tx
        .delete(ticketWatchers)
        .where(eq(ticketWatchers.ticketId, ticketId));
      await tx.delete(timesheets).where(eq(timesheets.ticketId, ticketId));
      await tx
        .delete(workItemRelations)
        .where(
          or(
            eq(workItemRelations.workItemId, ticketId),
            eq(workItemRelations.relatedWorkItemId, ticketId),
          ),
        );

      await tx
        .update(tickets)
        .set({ deletedAt: new Date() })
        .where(eq(tickets.id, ticketId));
    });

    this.webhooksDispatch.dispatch(
      orgId,
      existing.projectId,
      "ticket.deleted",
      {
        id: ticketId,
        projectId: existing.projectId,
        title: existing.title,
        actor: userId,
        timestamp: new Date().toISOString(),
      },
    );

    void this.cache
      .del(`projects:analytics:${orgId}:${existing.projectId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId, projectId: existing.projectId }));

    return { deleted: true };
  }

  async bulkUpdate(
    u: CurrentUserContext,
    projectId: number,
    body: BulkUpdateInput,
  ) {
    return this.query.bulkUpdate(u, projectId, body);
  }

  async rankTicket(u: CurrentUserContext, projectId: number, ticketId: number, body: RankTicketInput) {
    return this.query.rankTicket(u.orgId, projectId, ticketId, body, {
      userId: u.userId,
      isOrgOwner: u.isOrgOwner,
    });
  }

  async exportTickets(u: CurrentUserContext, projectId: number) {
    return this.transfer.exportTickets(u, projectId);
  }

  async importTickets(
    u: CurrentUserContext,
    projectId: number,
    body: ImportTicketsInput,
  ) {
    return this.transfer.importTickets(u, projectId, body);
  }

  async searchOrgTickets(
    orgId: string,
    userId: string,
    q: string,
    limit: number,
  ) {
    return this.workQuery.searchOrgTickets(orgId, userId, q, limit);
  }

  async getAllWork(u: CurrentUserContext, query: AllWorkQuery) {
    return this.workQuery.getAllWork(u, query);
  }
}
