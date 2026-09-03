import { supportTickets } from "../../../db/schema";
import type { TicketPriority, TicketStatus, UpdateTicketInput } from "./dto/support.schemas";

/**
 * The slice of SupportSlaService the update plan consults. Structural so the
 * pause/extension arithmetic can be exercised without the SLA module.
 */
export interface TicketSlaPort {
  resolvePolicy(
    orgId: string,
    priority: TicketPriority,
    category: string | null,
  ): Promise<{ pauseStatuses: string[] }>;
  computePauseTransition(
    previousStatus: TicketStatus,
    newStatus: TicketStatus,
    pauseStatuses: string[],
    slaPausedAt: Date | null,
    slaPausedMinutes: number,
  ): { slaPausedAt: Date | null; slaPausedMinutes: number; extendByMinutes: number };
}

export interface TicketSlaState {
  status: TicketStatus;
  priority: TicketPriority;
  category: string | null;
  slaPausedAt: Date | null;
  slaPausedMinutes: number;
  firstRespondedAt: Date | null;
  firstResponseDueAt: Date | null;
  slaDeadline: Date | null;
}

export type TicketUpdateData = Partial<typeof supportTickets.$inferInsert>;

/**
 * `assigneeMembershipId` is `undefined` when the caller did not touch the
 * assignee at all, and `null` when they explicitly cleared it.
 */
export async function buildTicketUpdateData(
  sla: TicketSlaPort,
  orgId: string,
  ticket: TicketSlaState,
  input: UpdateTicketInput,
  updatedAt: Date,
  assigneeMembershipId: number | null | undefined,
): Promise<TicketUpdateData> {
  const updateData: TicketUpdateData = { updatedAt };

  if (input.status) {
    updateData.status = input.status;
    if (input.status === "RESOLVED") updateData.resolvedAt = new Date();
    if (input.status === "CLOSED") updateData.closedAt = new Date();

    const policy = await sla.resolvePolicy(orgId, ticket.priority, ticket.category);
    const pauseTransition = sla.computePauseTransition(
      ticket.status,
      input.status,
      policy.pauseStatuses,
      ticket.slaPausedAt,
      ticket.slaPausedMinutes,
    );
    updateData.slaPausedAt = pauseTransition.slaPausedAt;
    updateData.slaPausedMinutes = pauseTransition.slaPausedMinutes;
    if (pauseTransition.extendByMinutes > 0) {
      const extendMs = pauseTransition.extendByMinutes * 60_000;
      if (!ticket.firstRespondedAt && ticket.firstResponseDueAt) {
        updateData.firstResponseDueAt = new Date(ticket.firstResponseDueAt.getTime() + extendMs);
      }
      if (ticket.slaDeadline) {
        updateData.slaDeadline = new Date(ticket.slaDeadline.getTime() + extendMs);
      }
    }
  }

  if (input.priority) updateData.priority = input.priority;
  if (assigneeMembershipId !== undefined) updateData.assigneeMembershipId = assigneeMembershipId;
  if (input.queueId !== undefined) updateData.queueId = input.queueId;

  return updateData;
}
