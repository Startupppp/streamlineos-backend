import { and, eq, isNull } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import { ticketTypeEnum, tickets } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";

type TicketType = (typeof ticketTypeEnum.enumValues)[number];

export async function readTicketVersionForSystemWrite(
  db: Db,
  orgId: string,
  ticketId: number,
): Promise<number> {
  const [row] = await db
    .select({ version: tickets.version })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
    .limit(1);
  if (!row) throw new NotFoundException("Ticket not found");
  return row.version;
}

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
