import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  projectWhiteboardShares,
  projectWhiteboards,
  projects,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import {
  assertRestorable,
  clearingLifecycle,
} from "../lifecycle/lifecycle-restore";
import { resolveWhiteboardAccess, type WhiteboardAccessLevel } from "./whiteboard-access";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreateWhiteboardInput,
  ListWhiteboardsQuery,
  UpdateWhiteboardInput,
} from "./dto/workspace.schemas";
import { loadShares, type BoardRow, type ShareEntry } from "./whiteboard-board-helpers";
import { assertProjectAccess, resolveProjectAccess } from "../core/project-crud/project-access";
import { resolveProjectsScope } from "../core/project-crud/projects-scope";
import { reachableProjectsSql } from "../core/project-crud/project-relationship";
import { actingMembershipId } from "../../../common/auth/principal";
import { decodeCursor, encodeCursor } from "../../../common/pagination/cursor";
import { keysetInteger, keysetTimestamp } from "../../../common/pagination/keyset";

@Injectable()
export class WhiteboardsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async hasManagePermission(user: CurrentUserContext): Promise<boolean> {
    return this.access.holds(user, "build:whiteboards:manage");
  }

  private async hasProjectAccess(user: CurrentUserContext, projectId: number): Promise<boolean> {
    const { hasAccess } = await resolveProjectAccess(this.db, this.access, user, projectId);
    return hasAccess;
  }

  private buildDto(
    board: BoardRow,
    access: WhiteboardAccessLevel,
    shares: ShareEntry[] | null,
  ) {
    return {
      id: board.id,
      projectId: board.projectId,
      name: board.name,
      data: board.data,
      visibility: board.visibility,
      access,
      sharing:
        access === "manage"
          ? {
              visibility: board.visibility,
              publicAccess: board.publicAccess,
              shareToken: null,
              linkExpiresAt: board.linkExpiresAt,
              allowExport: board.allowExport,
            }
          : null,
      shares,
      createdBy: board.createdBy,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    };
  }

  private async loadBoardWithAccess(
    u: CurrentUserContext,
    projectId: number,
    whiteboardId: number,
  ): Promise<{ board: BoardRow; access: WhiteboardAccessLevel }> {
    const hasProjectAccess = await this.hasProjectAccess(u, projectId);
    const rows = await this.db
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

    const hasManage = await this.hasManagePermission(u);
    const access = resolveWhiteboardAccess({
      board: { createdBy: row.board.createdBy, visibility: row.board.visibility },
      shareRole: row.shareRole ?? null,
      user: { userId: u.userId, isOrgOwner: u.isOrgOwner},
      hasManagePermission: hasManage,
      hasProjectAccess,
    });

    return { board: row.board, access };
  }

  async listWhiteboards(u: CurrentUserContext, projectId: number, query: ListWhiteboardsQuery) {
    const hasProjectAccess = await this.hasProjectAccess(u, projectId);

    const { limit, cursor } = query;
    const pos = cursor ? decodeCursor(cursor) : null;

    const visibilityFilter =
      u.isOrgOwner
        ? undefined
        : or(
            eq(projectWhiteboards.visibility, "public"),
            hasProjectAccess ? eq(projectWhiteboards.visibility, "project") : undefined,
            eq(projectWhiteboards.createdBy, u.userId),
            isNotNull(projectWhiteboardShares.role),
          );

    const cursorPredicate = pos
      ? (() => {
          const posUpdatedAt = keysetTimestamp(pos.sortValue);
          const posId = keysetInteger(pos.id);
          return or(
            lt(projectWhiteboards.updatedAt, sql.param(posUpdatedAt, projectWhiteboards.updatedAt)),
            and(
              sql`${projectWhiteboards.updatedAt} = ${sql.param(posUpdatedAt, projectWhiteboards.updatedAt)}`,
              sql`${projectWhiteboards.id} < ${sql.param(posId, projectWhiteboards.id)}`,
            ),
          );
        })()
      : undefined;

    const rawBoards = await this.db
      .select({
        id: projectWhiteboards.id,
        name: projectWhiteboards.name,
        data: projectWhiteboards.data,
        visibility: projectWhiteboards.visibility,
        createdBy: projectWhiteboards.createdBy,
        updatedAt: projectWhiteboards.updatedAt,
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
          eq(projectWhiteboards.orgId, u.orgId),
          eq(projectWhiteboards.projectId, projectId),
          isNull(projectWhiteboards.deletedAt),
          visibilityFilter,
          cursorPredicate,
        ),
      )
      .orderBy(desc(projectWhiteboards.updatedAt), desc(projectWhiteboards.id))
      .limit(limit + 1);

    const hasMore = rawBoards.length > limit;
    const boards = hasMore ? rawBoards.slice(0, limit) : rawBoards;

    const last = boards[boards.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ sortValue: last.updatedAt.toISOString(), id: String(last.id) })
        : null;

    return {
      data: boards.map((board) => ({
        id: board.id,
        name: board.name,
        elementCount: board.data.elements.length,
        visibility: board.visibility,
        createdBy: board.createdBy,
        updatedAt: board.updatedAt,
      })),
      pagination: { limit, hasMore, nextCursor },
    };
  }

  async listAllWhiteboards(u: CurrentUserContext) {
    const projectsRead = await resolveProjectsScope(this.access, u);
    const membershipId = actingMembershipId(u.principal);
    const reachableProject = projectsRead.compose(
      {
        tenant: projects.orgId,
        scope: { own: membershipId !== null ? reachableProjectsSql(u.orgId, membershipId) : sql`false` },
      },
      ({ sql: where }) => where,
      () => sql`false`,
    );
    const visibilityFilter =
      u.isOrgOwner
        ? undefined
        : or(
            eq(projectWhiteboards.visibility, "public"),
            and(eq(projectWhiteboards.visibility, "project"), reachableProject),
            eq(projectWhiteboards.createdBy, u.userId),
            isNotNull(projectWhiteboardShares.role),
          );

    const boards = await this.db
      .select({
        id: projectWhiteboards.id,
        name: projectWhiteboards.name,
        data: projectWhiteboards.data,
        visibility: projectWhiteboards.visibility,
        createdBy: projectWhiteboards.createdBy,
        updatedAt: projectWhiteboards.updatedAt,
        projectId: projectWhiteboards.projectId,
        projectName: projects.name,
      })
      .from(projectWhiteboards)
      .innerJoin(projects, and(eq(projects.id, projectWhiteboards.projectId), isNull(projects.deletedAt)))
      .leftJoin(
        projectWhiteboardShares,
        and(
          eq(projectWhiteboardShares.whiteboardId, projectWhiteboards.id),
          sql`${projectWhiteboardShares.membershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id = ${u.userId} AND status = 'ACTIVE')`,
        ),
      )
      .where(and(eq(projectWhiteboards.orgId, u.orgId), isNull(projectWhiteboards.deletedAt), visibilityFilter))
      .orderBy(desc(projectWhiteboards.updatedAt))
      .limit(100);

    return boards.map((board) => ({
      id: board.id,
      name: board.name,
      elementCount: board.data.elements.length,
      visibility: board.visibility,
      createdBy: board.createdBy,
      updatedAt: board.updatedAt,
      projectId: board.projectId,
      projectName: board.projectName,
    }));
  }

  async getWhiteboard(u: CurrentUserContext, projectId: number, whiteboardId: number) {
    const { board, access } = await this.loadBoardWithAccess(u, projectId, whiteboardId);
    if (access === "none") throw new NotFoundException("Whiteboard not found");
    const shares = access === "manage" ? await loadShares(this.db, whiteboardId) : null;
    return this.buildDto(board, access, shares);
  }

  async createWhiteboard(
    u: CurrentUserContext,
    projectId: number,
    input: CreateWhiteboardInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [board] = await this.db
      .insert(projectWhiteboards)
      .values({
        projectId,
        orgId: u.orgId,
        name: input.name,
        data: { elements: [] },
        createdBy: u.userId,
      })
      .returning();
    return this.buildDto(board, "manage", []);
  }

  async updateWhiteboard(
    u: CurrentUserContext,
    projectId: number,
    whiteboardId: number,
    input: UpdateWhiteboardInput,
  ) {
    const { board: _, access } = await this.loadBoardWithAccess(u, projectId, whiteboardId);

    if (access === "none") throw new NotFoundException("Whiteboard not found");
    if (access === "view") throw new ForbiddenException("Insufficient access to update whiteboard");
    if (input.name !== undefined && access !== "manage") {
      throw new ForbiddenException("Only board managers can rename whiteboards");
    }

    const [updated] = await this.db
      .update(projectWhiteboards)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectWhiteboards.id, whiteboardId),
          eq(projectWhiteboards.projectId, projectId),
          eq(projectWhiteboards.orgId, u.orgId),
          isNull(projectWhiteboards.deletedAt),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundException("Whiteboard not found");
    const shares = access === "manage" ? await loadShares(this.db, whiteboardId) : null;
    return this.buildDto(updated, access, shares);
  }

  async deleteWhiteboard(u: CurrentUserContext, projectId: number, whiteboardId: number) {
    const { access } = await this.loadBoardWithAccess(u, projectId, whiteboardId);

    if (access === "none") throw new NotFoundException("Whiteboard not found");
    if (access !== "manage") {
      throw new ForbiddenException("Only board managers can delete whiteboards");
    }

    await this.db
      .update(projectWhiteboards)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(projectWhiteboards.id, whiteboardId),
          eq(projectWhiteboards.projectId, projectId),
          eq(projectWhiteboards.orgId, u.orgId),
          isNull(projectWhiteboards.deletedAt),
        ),
      );
    this.audit.log({
      action: "build.whiteboard.deleted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_whiteboard",
      resourceId: String(whiteboardId),
      metadata: { whiteboardId, projectId },
    });
    return { success: true };
  }

  async restoreWhiteboard(u: CurrentUserContext, projectId: number, whiteboardId: number) {
    const hasProjectAccess = await this.hasProjectAccess(u, projectId);
    const existing = await this.db.query.projectWhiteboards.findFirst({
      where: and(
        eq(projectWhiteboards.id, whiteboardId),
        eq(projectWhiteboards.projectId, projectId),
        eq(projectWhiteboards.orgId, u.orgId),
      ),
      columns: { deletedAt: true, createdBy: true, visibility: true },
    });
    assertRestorable(existing, "Whiteboard");
    const access = resolveWhiteboardAccess({
      board: { createdBy: existing?.createdBy ?? null, visibility: existing?.visibility ?? "private" },
      shareRole: null,
      user: { userId: u.userId, isOrgOwner: u.isOrgOwner },
      hasManagePermission: await this.hasManagePermission(u),
      hasProjectAccess,
    });
    if (access !== "manage")
      throw new ForbiddenException("Only board managers can restore whiteboards");
    const [restored] = await clearingLifecycle("Whiteboard", () =>
      this.db
        .update(projectWhiteboards)
        .set({ deletedAt: null })
        .where(
          and(
            eq(projectWhiteboards.id, whiteboardId),
            eq(projectWhiteboards.projectId, projectId),
            eq(projectWhiteboards.orgId, u.orgId),
            isNotNull(projectWhiteboards.deletedAt),
          ),
        )
        .returning({ id: projectWhiteboards.id }),
    );
    if (!restored) throw new NotFoundException("Whiteboard not found");
    this.audit.log({
      action: "build.whiteboard.restored",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_whiteboard",
      resourceId: String(whiteboardId),
      metadata: { whiteboardId, projectId },
    });
    return { success: true };
  }
}
