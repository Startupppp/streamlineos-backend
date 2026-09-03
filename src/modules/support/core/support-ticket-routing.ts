import { logger } from "../../../common/logger/logger.service";
import type { RoutableTicket, RoutingOutcome } from "./support-macros-routing";
import type { CreateTicketInput, TicketPriority } from "./dto/support.schemas";

const TICKET_PRIORITIES: readonly TicketPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];

export function isTicketPriority(value: string): value is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(value);
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
