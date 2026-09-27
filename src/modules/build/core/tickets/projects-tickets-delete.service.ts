import {
  ConflictException,
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
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsWebhooksDispatchService } from "../projects-webhooks-dispatch.service";
import { AccessService } from "../../../access/access.service";
import {
  assertTicketReadAccess,
  type TicketReadAccess,
} from "./build-ticket-read-access";

const BLOCKER_PROBE_LIMIT = 50;

@Injectable()
export class ProjectsTicketsDeleteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly cache: CacheService,
    @Inject(AccessService) private readonly access: TicketReadAccess,
  ) {}

  async deleteTicket(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    force: boolean,
  ) {
    const { orgId, userId } = u;
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
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

    if (!force) {
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
}
