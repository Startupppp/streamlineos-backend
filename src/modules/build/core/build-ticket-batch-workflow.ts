import { randomUUID } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { Db } from "../../../db/drizzle.types";
import { ProjectsInvalidTicketStatusException } from "../../../common/http/api-exceptions";
import { assertTransitionAllowed, fetchTransitionsAndStatuses } from "./projects-tickets-workflow-utils";
import type { readMutationTickets } from "./build-ticket-mutation-policy";
import { reserveTicketCapacity } from "./build-ticket-capacity";

type MutationRows = Awaited<ReturnType<typeof readMutationTickets>>;

export async function validateBatchTransition(db: Db, actor: CurrentUserContext, projectId: number, rows: MutationRows, status: string, role: string | null) {
  const workflow = await fetchTransitionsAndStatuses(db, actor.orgId, projectId);
  if (!["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", ...workflow.statuses.map((row) => row.name)].includes(status))
    throw new ProjectsInvalidTicketStatusException(status);
  const changed = rows.filter((row) => row.status !== status);
  if (changed.length > 0)
    await reserveTicketCapacity(db, actor.orgId, projectId, [{ status, count: rows.length }], rows.map(row => row.id));
  const prefetched = { ...workflow, ticketFields: new Map(rows.map((row) => [row.id, row])), wipAlreadyChecked: true };
  for (const row of changed)
    await assertTransitionAllowed(db, actor.orgId, projectId, row.status, status, {
      userId: actor.userId, userProjectRole: role, isOrgOwner: actor.isOrgOwner, ticketId: row.id,
    }, prefetched);
}

export async function emitBatchStatusChanges(db: Db, actor: CurrentUserContext, projectId: number, rows: MutationRows, status: string, now: Date) {
  await OutboxWriter.emitMany(db, rows.filter((row) => row.status !== status).map((row) => ({
    eventId: randomUUID(), organizationId: actor.orgId, aggregateType: "ticket", aggregateId: String(row.id),
    aggregateVersion: row.version + 1, eventType: "build.ticket.status_changed", occurredAt: now,
    payload: { ticketId: row.id, projectId, orgId: actor.orgId, previousStatus: row.status, newStatus: status, actorUserId: actor.userId },
  })));
}
