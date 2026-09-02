import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  organizationMembers,
  projectWhiteboardShares,
  projectWhiteboards,
  projects,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { resolveWhiteboardAccess } from "./whiteboard-access";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  ExcalidrawSceneInput,
  SetWhiteboardSharesInput,
  UpdateWhiteboardSharingInput,
} from "./dto/workspace.schemas";

async function assertProject(db: Db, orgId: string, projectId: number): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
    columns: { id: true },
  });
  if (!project) throw new NotFoundException("Project not found");
}

@Injectable()
export class WhiteboardSharingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private async requireManageAccess(
    u: CurrentUserContext,
    projectId: number,
    whiteboardId: number,
  ): Promise<typeof projectWhiteboards.$inferSelect> {
    await assertProject(this.db, u.orgId, projectId);

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

    const hasManagePermission = await this.access.holds(
      u,
      "build:whiteboards:manage",
    );

    const access = resolveWhiteboardAccess({
      board: { createdBy: row.board.createdBy, visibility: row.board.visibility },
      shareRole: row.shareRole ?? null,
      user: { userId: u.userId, isOrgOwner: u.isOrgOwner},
      hasManagePermission,
    });

    if (access !== "manage") throw new ForbiddenException("Manage access required");
    return row.board;
  }

  async updateSharing(
    u: CurrentUserContext,
    projectId: number,
    whiteboardId: number,
    input: UpdateWhiteboardSharingInput,
  ) {
    const board = await this.requireManageAccess(u, projectId, whiteboardId);

    const newVisibility = input.visibility ?? board.visibility;
    const willBePublic = newVisibility === "public";
    const needsToken = willBePublic && board.shareToken === null;
    const newToken = needsToken ? randomBytes(24).toString("base64url") : undefined;

    const setValues: Partial<typeof projectWhiteboards.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.visibility !== undefined) setValues.visibility = input.visibility;
    if (input.publicAccess !== undefined) setValues.publicAccess = input.publicAccess;
    if (input.linkExpiresAt !== undefined) {
      setValues.linkExpiresAt = input.linkExpiresAt === null ? null : new Date(input.linkExpiresAt);
    }
    if (input.allowExport !== undefined) setValues.allowExport = input.allowExport;
    if (newToken) setValues.shareToken = newToken;

    const [updated] = await this.db
      .update(projectWhiteboards)
      .set(setValues)
      .where(and(eq(projectWhiteboards.id, whiteboardId), eq(projectWhiteboards.orgId, u.orgId), isNull(projectWhiteboards.deletedAt)))
      .returning();

    return {
      visibility: updated.visibility,
      publicAccess: updated.publicAccess,
      shareToken: updated.shareToken,
      linkExpiresAt: updated.linkExpiresAt,
      allowExport: updated.allowExport,
    };
  }

  async rotateShareToken(
    u: CurrentUserContext,
    projectId: number,
    whiteboardId: number,
  ) {
    await this.requireManageAccess(u, projectId, whiteboardId);
    const newToken = randomBytes(24).toString("base64url");

    const [updated] = await this.db
      .update(projectWhiteboards)
      .set({ shareToken: newToken, updatedAt: new Date() })
      .where(and(eq(projectWhiteboards.id, whiteboardId), eq(projectWhiteboards.orgId, u.orgId), isNull(projectWhiteboards.deletedAt)))
      .returning();

    return {
      visibility: updated.visibility,
      publicAccess: updated.publicAccess,
      shareToken: updated.shareToken,
      linkExpiresAt: updated.linkExpiresAt,
      allowExport: updated.allowExport,
    };
  }

  async setShares(
    u: CurrentUserContext,
    projectId: number,
    whiteboardId: number,
    input: SetWhiteboardSharesInput,
  ) {
    const board = await this.requireManageAccess(u, projectId, whiteboardId);
    const { shares } = input;
    let members: Array<{ id: number; userId: string }> = [];

    if (shares.length > 0) {
      const userIds = shares.map((s) => s.userId);
      members = await this.db
        .select({ id: organizationMembers.id, userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, u.orgId),
            inArray(organizationMembers.userId, userIds),
          ),
        );

      const memberSet = new Set(members.map((m) => m.userId));
      const unknown = userIds.filter((id) => !memberSet.has(id));
      if (unknown.length > 0) {
        throw new BadRequestException(`Unknown member(s): ${unknown.join(", ")}`);
      }
    }

    const excluded = new Set([board.createdBy ?? "", u.userId]);
    const filteredShares = shares.filter((s) => !excluded.has(s.userId));
    const membershipByUserId = new Map(members.map((m) => [m.userId, m.id]));
    const rows = filteredShares.map((s) => {
      const membershipId = membershipByUserId.get(s.userId);
      if (membershipId === undefined)
        throw new BadRequestException(`Unknown member(s): ${s.userId}`);
      return {
        orgId: u.orgId,
        whiteboardId,
        membershipId,
        role: s.role,
        createdBy: u.userId,
      };
    });

    await this.db.transaction(async (tx) => {
      await tx
        .delete(projectWhiteboardShares)
        .where(eq(projectWhiteboardShares.whiteboardId, whiteboardId));

      if (rows.length > 0) await tx.insert(projectWhiteboardShares).values(rows);
    });

    return this.db
      .select({
        userId: organizationMembers.userId,
        role: projectWhiteboardShares.role,
        name: users.name,
        email: users.email,
      })
      .from(projectWhiteboardShares)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectWhiteboardShares.orgId), eq(organizationMembers.id, projectWhiteboardShares.membershipId)))
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(projectWhiteboardShares.whiteboardId, whiteboardId));
  }

  async removeShare(
    u: CurrentUserContext,
    projectId: number,
    whiteboardId: number,
    targetUserId: string,
  ) {
    await this.requireManageAccess(u, projectId, whiteboardId);
    await this.db
      .delete(projectWhiteboardShares)
      .where(
        and(
          eq(projectWhiteboardShares.whiteboardId, whiteboardId),
          sql`${projectWhiteboardShares.membershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id = ${targetUserId} AND status = 'ACTIVE')`,
        ),
      );
    return { success: true };
  }

  async getPublicByToken(token: string) {
    const board = await withPublicToken(this.db, token, (tx) =>
      tx.query.projectWhiteboards.findFirst({
        where: and(eq(projectWhiteboards.shareToken, token), isNull(projectWhiteboards.deletedAt)),
        columns: {
          name: true,
          data: true,
          visibility: true,
          publicAccess: true,
          linkExpiresAt: true,
          allowExport: true,
          updatedAt: true,
        },
      }),
    );

    if (
      !board ||
      board.visibility !== "public" ||
      (board.linkExpiresAt !== null && board.linkExpiresAt < new Date())
    ) {
      throw new NotFoundException("Not found");
    }

    return {
      name: board.name,
      data: board.data,
      access: board.publicAccess === "editor" ? ("edit" as const) : ("view" as const),
      allowExport: board.allowExport,
      updatedAt: board.updatedAt,
    };
  }

  async updatePublicByToken(token: string, data: ExcalidrawSceneInput) {
    const board = await withPublicToken(this.db, token, (tx) =>
      tx.query.projectWhiteboards.findFirst({
        where: and(eq(projectWhiteboards.shareToken, token), isNull(projectWhiteboards.deletedAt)),
        columns: { id: true, orgId: true, visibility: true, publicAccess: true, linkExpiresAt: true },
      }),
    );

    if (
      !board ||
      board.visibility !== "public" ||
      (board.linkExpiresAt !== null && board.linkExpiresAt < new Date())
    ) {
      throw new NotFoundException("Not found");
    }

    if (board.publicAccess !== "editor") {
      throw new ForbiddenException("Link is view-only");
    }

    const now = new Date();
    const updated = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .update(projectWhiteboards)
          .set({ data, updatedAt: now })
          .where(
            and(
              eq(projectWhiteboards.id, board.id),
              eq(projectWhiteboards.shareToken, token),
              eq(projectWhiteboards.visibility, "public"),
              eq(projectWhiteboards.publicAccess, "editor"),
              or(
                isNull(projectWhiteboards.linkExpiresAt),
                gt(projectWhiteboards.linkExpiresAt, now),
              ),
            ),
          )
          .returning({ updatedAt: projectWhiteboards.updatedAt });
        return row;
      },
      { orgId: board.orgId },
    );

    if (!updated) throw new NotFoundException("Not found");
    return { success: true, updatedAt: updated.updatedAt };
  }
}
