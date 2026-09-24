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
import { ProjectsSearchService } from "./projects-search.service";
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

/**
 * How many blockers the delete guard reads before it stops counting.
 *
 * The guard is a yes/no question with a number attached for the message, so it
 * never needs the whole set — and an unbounded read here grows with the size of
 * the dependency graph a caller happens to have built.
 */
const BLOCKER_PROBE_LIMIT = 50;

@Injectable()
export class ProjectsTicketsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly query: ProjectsTicketsQueryService,
    private readonly workQuery: ProjectsWorkQueryService,
    private readonly search: ProjectsSearchService,
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
    input: { title: string; description: string; type?: string; assigneeMembershipId?: number | null },
  ): Promise<{ id: number }> {
    return this.create.createFromFeedback(orgId, actingUserId, projectId, input);
  }

  async getTicketByKey(u: CurrentUserContext, projectId: number, ticketNumber: number) {
    return this.detail.getTicketByKey(u, projectId, ticketNumber);
  }

  async getTicket(u: CurrentUserContext, projectId: number, ticketId: number) {
    return this.detail.getTicket(u, projectId, ticketId);
  }

  async updateTicket(
    u: CurrentUserContext,
    projectId: number | null,
    ticketId: number,
    input: UpdateTicketInput,
  ) {
    return this.update.updateTicket(u, projectId, ticketId, input);
  }

  async deleteTicket(
    orgId: string,
    userId: string,
    projectId: number,
    ticketId: number,
    force: boolean,
  ) {
    const existing = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true, projectId: true, title: true },
    });
    if (!existing || !existing.projectId)
      throw new NotFoundException("Ticket not found");
    const ticketProjectId = existing.projectId;

    const { hasAccess } = await this.read.checkProjectAccess(
      orgId,
      userId,
      ticketProjectId,
    );
    if (!hasAccess)
      throw new ForbiddenException("Not authorized to delete this ticket");

    if (!force) {
      /**
       * Bounded, and scoped to the organisation.
       *
       * The limit is the substantive fix: this read had none, so a yes/no
       * question materialised every blocker a caller had ever created. The
       * branch needs to know whether any blocker exists and roughly how many,
       * not to load the whole dependency graph.
       *
       * The `orgId` predicate is defence in depth rather than a leak that was
       * reachable. `related_work_item_id` carries a composite foreign key on
       * `(org_id, related_work_item_id)` into `(tickets.org_id, tickets.id)`,
       * and `tickets.id` is a globally unique identity column — so a row
       * matching this ticket id already had to belong to this ticket's
       * organisation. The predicate states the tenant rather than resting on
       * that inference, and keeps the scan on the organisation-leading index.
       */
      const blockedBy = await this.db.query.workItemRelations.findMany({
        where: and(
          eq(workItemRelations.orgId, orgId),
          eq(workItemRelations.relatedWorkItemId, ticketId),
          eq(workItemRelations.relationType, "blocks"),
        ),
        columns: { workItemId: true },
        limit: BLOCKER_PROBE_LIMIT,
      });
      if (blockedBy.length > 0) {
        // Honest about the cap: at the limit the real count is unknown, and
        // reporting the sentinel as if it were exact understates it silently.
        const count =
          blockedBy.length === BLOCKER_PROBE_LIMIT
            ? `${String(BLOCKER_PROBE_LIMIT)}+`
            : String(blockedBy.length);
        throw new ConflictException(
          `This ticket is blocked by ${count} other ticket(s). Add ?force=true to delete anyway.`,
        );
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ parentTicketId: null })
        .where(and(eq(tickets.orgId, orgId), eq(tickets.parentTicketId, ticketId)));
      await tx
        .update(tickets)
        .set({ epicId: null })
        .where(and(eq(tickets.orgId, orgId), eq(tickets.epicId, ticketId)));

      await tx
        .delete(ticketAssignees)
        .where(and(eq(ticketAssignees.orgId, orgId), eq(ticketAssignees.ticketId, ticketId)));
      await tx
        .delete(ticketComments)
        .where(and(eq(ticketComments.orgId, orgId), eq(ticketComments.ticketId, ticketId)));
      await tx
        .delete(ticketAttachments)
        .where(and(eq(ticketAttachments.orgId, orgId), eq(ticketAttachments.ticketId, ticketId)));
      await tx
        .delete(ticketLabelMappings)
        .where(and(eq(ticketLabelMappings.orgId, orgId), eq(ticketLabelMappings.ticketId, ticketId)));
      await tx
        .delete(ticketWatchers)
        .where(and(eq(ticketWatchers.orgId, orgId), eq(ticketWatchers.ticketId, ticketId)));
      await tx
        .delete(timesheets)
        .where(and(eq(timesheets.orgId, orgId), eq(timesheets.ticketId, ticketId)));
      await tx
        .delete(workItemRelations)
        .where(
          or(
            and(eq(workItemRelations.orgId, orgId), eq(workItemRelations.workItemId, ticketId)),
            and(eq(workItemRelations.orgId, orgId), eq(workItemRelations.relatedWorkItemId, ticketId)),
          ),
        );

      await tx
        .update(tickets)
        .set({ deletedAt: new Date() })
        .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId)));

      await this.webhooksDispatch.enqueue(tx, orgId, ticketProjectId, "ticket.deleted", {
        id: ticketId,
        projectId: ticketProjectId,
        title: existing.title,
        actor: userId,
        timestamp: new Date().toISOString(),
      });
    });

    void this.cache
      .invalidateNamespace(`build:analytics:${orgId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId, projectId: ticketProjectId }));

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
    return this.query.rankTicket(u, projectId, ticketId, body);
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
    return this.search.searchOrgTickets(orgId, userId, q, limit);
  }

  async getAllWork(u: CurrentUserContext, query: AllWorkQuery) {
    return this.workQuery.getAllWork(u, query);
  }

  async getColumnCounts(u: CurrentUserContext, projectId: number) {
    return this.read.getColumnCounts(u, projectId);
  }
}
