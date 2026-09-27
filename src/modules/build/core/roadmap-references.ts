import { NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { roadmapItems, tickets } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { assertProjectInOrg } from "./project-access";

export async function assertTicketInOrg(
  db: Db,
  orgId: string,
  ticketId: number,
): Promise<void> {
  const [row] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        eq(tickets.id, ticketId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Ticket not found");
}

export async function assertRoadmapItemInOrg(
  db: Db,
  orgId: string,
  itemId: number,
): Promise<void> {
  const [row] = await db
    .select({ id: roadmapItems.id })
    .from(roadmapItems)
    .where(
      and(
        eq(roadmapItems.id, itemId),
        eq(roadmapItems.orgId, orgId),
        isNull(roadmapItems.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Roadmap item not found");
}

export async function assertRoadmapTargetsInOrg(
  db: Db,
  orgId: string,
  input: { projectId?: number | null; epicTicketId?: number | null },
): Promise<void> {
  if (input.projectId !== undefined && input.projectId !== null)
    await assertProjectInOrg(db, orgId, input.projectId);
  if (input.epicTicketId !== undefined && input.epicTicketId !== null)
    await assertTicketInOrg(db, orgId, input.epicTicketId);
}

export async function assertLinkedRoadmapItemInOrg(
  db: Db,
  orgId: string,
  linkedRoadmapItemId: number | null | undefined,
): Promise<void> {
  if (linkedRoadmapItemId === undefined || linkedRoadmapItemId === null) return;
  await assertRoadmapItemInOrg(db, orgId, linkedRoadmapItemId);
}
