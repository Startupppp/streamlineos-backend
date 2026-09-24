import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  projectWhiteboardShares,
  projectWhiteboards,
  projects,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { resolveWhiteboardAccess, type WhiteboardAccessLevel } from "./whiteboard-access";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreateWhiteboardInput,
  UpdateWhiteboardInput,
} from "./dto/workspace.schemas";
import { assertProject, loadShares, type BoardRow, type ShareEntry } from "./whiteboard-board-helpers";

@Injectable()
export class WhiteboardsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async hasManagePermission(user: CurrentUserContext): Promise<boolean> {
    return this.access.holds(user, "build:whiteboards:manage");
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
    });

    return { board: row.board, access };
  }

  async listWhiteboards(u: CurrentUserContext, projectId: number) {
    await assertProject(this.db, u.orgId, projectId);

    const visibilityFilter =
      u.isOrgOwner
        ? undefined
        : or(
            ne(projectWhiteboards.visibility, "private"),
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
        ),
      )
      .orderBy(desc(projectWhiteboards.updatedAt))
      .limit(100);

    return boards.map((board) => ({
      id: board.id,
      name: board.name,
      elementCount: board.data.elements.length,
      visibility: board.visibility,
      createdBy: board.createdBy,
      updatedAt: board.updatedAt,
    }));
  }

  async listAllWhiteboards(u: CurrentUserContext) {
    const visibilityFilter =
      u.isOrgOwner
        ? undefined
        : or(
            ne(projectWhiteboards.visibility, "private"),
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
      .innerJoin(projects, eq(projects.id, projectWhiteboards.projectId))
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
    await assertProject(this.db, u.orgId, projectId);
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
    await assertProject(this.db, u.orgId, projectId);
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
    await assertProject(this.db, u.orgId, projectId);
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
    await assertProject(this.db, u.orgId, projectId);
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
    return { success: true };
  }
}
