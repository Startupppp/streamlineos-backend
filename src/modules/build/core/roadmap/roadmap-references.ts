import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { roadmapItems } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import {
  assertProjectAccess,
  decideTicketRead,
  type TicketReadAccess,
} from "../project-crud/project-access";

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

export async function assertRoadmapTargetsReachable(
  db: Db,
  access: TicketReadAccess,
  actor: CurrentUserContext,
  input: { projectId?: number | null; epicTicketId?: number | null },
): Promise<void> {
  if (input.projectId !== undefined && input.projectId !== null)
    await assertProjectAccess(db, access, actor, input.projectId);
  if (input.epicTicketId === undefined || input.epicTicketId === null) return;
  const epic = await decideTicketRead(db, access, actor, input.epicTicketId, { projectId: null });
  if (epic.kind === "missing") throw new NotFoundException("Ticket not found");
  if (epic.kind === "denied") throw new ForbiddenException("Ticket is outside your access scope");
}

export async function assertLinkedRoadmapItemInOrg(
  db: Db,
  orgId: string,
  linkedRoadmapItemId: number | null | undefined,
): Promise<void> {
  if (linkedRoadmapItemId === undefined || linkedRoadmapItemId === null) return;
  await assertRoadmapItemInOrg(db, orgId, linkedRoadmapItemId);
}
