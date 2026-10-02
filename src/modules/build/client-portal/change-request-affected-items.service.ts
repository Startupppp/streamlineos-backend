import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { changeRequestAffectedItems, tickets } from "../../../db/schema";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { isUniqueViolationOn } from "../../../common/db/postgres-error";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ChangeRequestsService } from "./change-requests.service";
import { AccessService } from "../../access/access.service";
import { assertTicketReadAccess } from "../core";
import type {
  LinkAffectedTicketInput,
  ListAffectedTicketsQuery,
} from "./dto/change-request-affected-items.schemas";

const ticketSummaryColumns = {
  id: tickets.id,
  projectId: tickets.projectId,
  title: tickets.title,
  ticketNumber: tickets.ticketNumber,
  status: tickets.status,
  priority: tickets.priority,
  type: tickets.type,
};

function toWireItem(row: {
  id: number;
  orgId: string;
  changeRequestId: number;
  ticketId: number;
  createdAt: Date;
  createdBy: string | null;
  ticket: {
    id: number;
    title: string;
    ticketNumber: number;
    status: string;
    priority: string;
    type: string;
  };
}) {
  return {
    id: row.id,
    orgId: row.orgId,
    changeRequestId: row.changeRequestId,
    ticketId: row.ticketId,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    ticket: row.ticket,
  };
}

@Injectable()
export class ChangeRequestAffectedItemsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly changeRequests: ChangeRequestsService,
    private readonly access: AccessService,
  ) {}

  async listAffectedTickets(
    u: CurrentUserContext,
    projectId: number,
    changeRequestId: number,
    query: ListAffectedTicketsQuery,
  ) {
    await this.changeRequests.getChangeRequest(u, projectId, changeRequestId);
    const { orgId } = u;
    const limit = query.limit ?? 25;
    const position = decodeCursor(query.cursor ?? null);

    const rows = await this.db
      .select({
        id: changeRequestAffectedItems.id,
        orgId: changeRequestAffectedItems.orgId,
        changeRequestId: changeRequestAffectedItems.changeRequestId,
        ticketId: changeRequestAffectedItems.ticketId,
        createdAt: changeRequestAffectedItems.createdAt,
        createdBy: changeRequestAffectedItems.createdBy,
        ticket: ticketSummaryColumns,
      })
      .from(changeRequestAffectedItems)
      .innerJoin(
        tickets,
        and(
          eq(tickets.orgId, changeRequestAffectedItems.orgId),
          eq(tickets.id, changeRequestAffectedItems.ticketId),
        ),
      )
      .where(
        and(
          eq(changeRequestAffectedItems.orgId, orgId),
          eq(changeRequestAffectedItems.changeRequestId, changeRequestId),
          isNull(tickets.deletedAt),
          position
            ? keysetBeforeId(changeRequestAffectedItems.createdAt, changeRequestAffectedItems.id, position)
            : undefined,
        ),
      )
      .orderBy(desc(changeRequestAffectedItems.createdAt), desc(changeRequestAffectedItems.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: (row.createdAt ?? new Date(0)).toISOString(),
      id: String(row.id),
    }));
    return { data: page.data.map(toWireItem), pagination: page.pagination };
  }

  async linkTicket(
    u: CurrentUserContext,
    projectId: number,
    changeRequestId: number,
    input: LinkAffectedTicketInput,
  ) {
    const { orgId, userId } = u;
    await this.changeRequests.getChangeRequest(u, projectId, changeRequestId);
    await assertTicketReadAccess(this.db, this.access, u, projectId, input.ticketId);

    const [ticket] = await this.db
      .select(ticketSummaryColumns)
      .from(tickets)
      .where(and(eq(tickets.id, input.ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
      .limit(1);
    if (!ticket || ticket.projectId !== projectId) {
      throw new NotFoundException("Ticket not found");
    }

    try {
      const [row] = await this.db
        .insert(changeRequestAffectedItems)
        .values({
          orgId,
          changeRequestId,
          ticketId: input.ticketId,
          createdBy: userId,
        })
        .returning({
          id: changeRequestAffectedItems.id,
          orgId: changeRequestAffectedItems.orgId,
          changeRequestId: changeRequestAffectedItems.changeRequestId,
          ticketId: changeRequestAffectedItems.ticketId,
          createdAt: changeRequestAffectedItems.createdAt,
          createdBy: changeRequestAffectedItems.createdBy,
        });
      this.audit.log({
        action: "change_request.ticket_linked",
        userId,
        orgId,
        resourceType: "change_request_affected_item",
        resourceId: String(row.id),
        metadata: { crId: changeRequestId, projectId, ticketId: input.ticketId },
      });
      return toWireItem({ ...row, ticket });
    } catch (err) {
      if (isUniqueViolationOn(err, "uniq_change_request_affected_items_pair")) {
        throw new ConflictException("This ticket is already linked to this change request");
      }
      throw err;
    }
  }

  async unlinkTicket(
    u: CurrentUserContext,
    projectId: number,
    changeRequestId: number,
    affectedItemId: number,
  ): Promise<void> {
    const { orgId, userId } = u;
    await this.changeRequests.getChangeRequest(u, projectId, changeRequestId);

    const [existing] = await this.db
      .select({ id: changeRequestAffectedItems.id, ticketId: changeRequestAffectedItems.ticketId })
      .from(changeRequestAffectedItems)
      .where(
        and(
          eq(changeRequestAffectedItems.id, affectedItemId),
          eq(changeRequestAffectedItems.orgId, orgId),
          eq(changeRequestAffectedItems.changeRequestId, changeRequestId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Affected ticket link not found");

    await this.db
      .delete(changeRequestAffectedItems)
      .where(
        and(
          eq(changeRequestAffectedItems.id, affectedItemId),
          eq(changeRequestAffectedItems.orgId, orgId),
        ),
      );
    this.audit.log({
      action: "change_request.ticket_unlinked",
      userId,
      orgId,
      resourceType: "change_request_affected_item",
      resourceId: String(affectedItemId),
      metadata: { crId: changeRequestId, projectId, ticketId: existing.ticketId },
    });
  }
}
