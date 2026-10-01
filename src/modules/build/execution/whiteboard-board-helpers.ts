import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  organizationMembers,
  projectWhiteboardShares,
  projectWhiteboards,
  users,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { resolveWhiteboardAccess } from "./whiteboard-access";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import { resolveProjectAccess } from "../core/project-crud/project-access";

export type ShareEntry = {
  userId: string;
  role: "viewer" | "editor";
  name: string | null;
  email: string;
};

export type BoardRow = typeof projectWhiteboards.$inferSelect;

export async function loadShares(db: Db, whiteboardId: number): Promise<ShareEntry[]> {
  return db
    .select({
      userId: organizationMembers.userId,
      role: projectWhiteboardShares.role,
      name: users.name,
      email: users.email,
    })
    .from(projectWhiteboardShares)
    .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectWhiteboardShares.orgId), eq(organizationMembers.id, projectWhiteboardShares.membershipId)))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(projectWhiteboardShares.whiteboardId, whiteboardId))
    .limit(PAGE_SIZE_CAP);
}

export async function requireWhiteboardManageAccess(
  db: Db,
  access: AccessService,
  u: CurrentUserContext,
  projectId: number,
  whiteboardId: number,
): Promise<typeof projectWhiteboards.$inferSelect> {
  const { hasAccess: hasProjectAccess } = await resolveProjectAccess(db, access, u, projectId);

  const rows = await db
    .select({
      board: projectWhiteboards,
      shareRole: projectWhiteboardShares.role,
    })
    .from(projectWhiteboards)
    .leftJoin(
      projectWhiteboardShares,
      and(
        eq(projectWhiteboardShares.whiteboardId, projectWhiteboards.id),
        sql`${projectWhiteboardShares.membershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id = ${u.userId} AND status = 'ACTIVE')`,
      ),
    )
    .where(
      and(
        eq(projectWhiteboards.id, whiteboardId),
        eq(projectWhiteboards.projectId, projectId),
        eq(projectWhiteboards.orgId, u.orgId),
        isNull(projectWhiteboards.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundException("Whiteboard not found");

  const hasManagePermission = await access.holds(u, "build:whiteboards:manage");

  const resolvedAccess = resolveWhiteboardAccess({
    board: { createdBy: row.board.createdBy, visibility: row.board.visibility },
    shareRole: row.shareRole ?? null,
    user: { userId: u.userId, isOrgOwner: u.isOrgOwner },
    hasManagePermission,
    hasProjectAccess,
  });

  if (resolvedAccess !== "manage") throw new ForbiddenException("Manage access required");
  return row.board;
}
