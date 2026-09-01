import type { RoutingRuleCondition } from "../../../db/schema";

export interface RoutableTicket {
  title?: string | null;
  category?: string | null;
  description?: string | null;
  priority?: string | null;
  isVip?: boolean;
}

export interface RoutingOutcome {
  assigneeId?: string;
  setPriority?: string;
}

function resolveRoutingField(ticket: RoutableTicket, field: string): string | null {
  switch (field) {
    case "title":
    case "subject":
      return ticket.title ?? null;
    case "category":
      return ticket.category ?? null;
    case "description":
      return ticket.description ?? null;
    case "priority":
      return ticket.priority ?? null;
    case "isVip":
      return ticket.isVip ? "true" : "false";
    default:
      return null;
  }
}

export function matchesRoutingCondition(
  ticket: RoutableTicket,
  condition: RoutingRuleCondition,
): boolean {
  const fieldValue = resolveRoutingField(ticket, condition.field);
  const actual = (fieldValue ?? "").toLowerCase();
  const expected = (condition.value ?? "").toLowerCase();

  switch (condition.op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "contains":
      return actual.includes(expected);
    default:
      return false;
  }
}
