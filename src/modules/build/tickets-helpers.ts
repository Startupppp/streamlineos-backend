import { ticketTypeEnum } from "../../db/schema";

type TicketType = (typeof ticketTypeEnum.enumValues)[number];

export function normalizeTicketType(type: string): TicketType {
  const upper = type.toUpperCase();
  const mapped = upper === "FEATURE" ? "STORY" : upper;
  return ticketTypeEnum.enumValues.find((v) => v === mapped) ?? "TASK";
}

export function resolveAssigneeId(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "" || raw === "unassigned") return null;
  return raw;
}
