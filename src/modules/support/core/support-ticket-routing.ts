import { logger } from "../../../common/logger/logger.service";
import type { RoutableTicket, RoutingOutcome } from "./support-macros-routing";
import { ticketPrioritySchema, ticketStatusSchema, type TicketStatus } from "./dto/support-tickets.schemas";
import type { CreateTicketInput, TicketPriority } from "./dto/support.schemas";

/**
 * `RoutingOutcome.setPriority` is a bare `string` — it is whatever a stored
 * routing rule was configured with, so it is untrusted input rather than a
 * value the type system already knows.
 *
 * Narrowed by parsing it with the same Zod enum every ticket DTO uses. The
 * previous form kept a second, hand-written list of the four priorities and
 * widened it back to `readonly string[]` to call `.includes` — two sources of
 * truth, and the assertion is what let them disagree: adding a priority to the
 * schema would have left this list short and silently dropped the new value.
 */
export function isTicketPriority(value: string): value is TicketPriority {
  return ticketPrioritySchema.safeParse(value).success;
}

/** Same reasoning as {@link isTicketPriority}: narrow via the schema, not a second hand-written list. */
export function isTicketStatus(value: string): value is TicketStatus {
  return ticketStatusSchema.safeParse(value).success;
}

/**
 * The slice of SupportMacrosService ticket routing needs. Structural so the
 * routing rule evaluation stays testable without the macros module.
 */
export interface TicketRoutingPort {
  isVipClient(orgId: string, clientId: number | null | undefined): Promise<boolean>;
  applyRoutingRules(orgId: string, ticket: RoutableTicket): Promise<RoutingOutcome>;
}

export type TicketRoutingInput = Pick<
  CreateTicketInput,
  "title" | "category" | "description" | "clientId" | "priority" | "assigneeId"
>;

export interface TicketRoutingDecision {
  priority: TicketPriority;
  assigneeId: string | undefined;
}

export async function resolveTicketRouting(
  macros: TicketRoutingPort,
  orgId: string,
  input: TicketRoutingInput,
): Promise<TicketRoutingDecision> {
  const callerSetPriority = input.priority !== undefined;
  let priority: TicketPriority = input.priority ?? "MEDIUM";
  let assigneeId = input.assigneeId;

  try {
    const isVip = await macros.isVipClient(orgId, input.clientId ?? null);
    const routing = await macros.applyRoutingRules(orgId, {
      title: input.title,
      category: input.category ?? null,
      description: input.description ?? null,
      priority,
      isVip,
    });
    if (routing.assigneeId && !input.assigneeId) {
      assigneeId = routing.assigneeId;
    }
    if (routing.setPriority && !callerSetPriority && isTicketPriority(routing.setPriority)) {
      priority = routing.setPriority;
    }
  } catch (routingError) {
    logger.error("Support routing rules failed to apply", {
      orgId,
      error: routingError instanceof Error ? routingError.message : String(routingError),
    });
  }

  return { priority, assigneeId };
}
