import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, gt, isNull, or } from "drizzle-orm";
import { projectClientGrants, projects } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess } from "../core/project-access";

@Injectable()
export class ClientPortalManagementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getSettings(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [project] = await this.db
      .select({ portalPublishedAt: projects.portalPublishedAt })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");

    const now = new Date();
    const [grantCountRow] = await this.db
      .select({ count: count() })
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, u.orgId),
          eq(projectClientGrants.projectId, projectId),
          eq(projectClientGrants.status, "ACTIVE"),
          or(isNull(projectClientGrants.expiresAt), gt(projectClientGrants.expiresAt, now)),
        ),
      )
      .limit(1);

    return {
      portalPublishedAt: project.portalPublishedAt,
      grantCount: grantCountRow?.count ?? 0,
    };
  }

  async publishPortal(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [updated] = await this.db
      .update(projects)
      .set({ portalPublishedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)))
      .returning({ portalPublishedAt: projects.portalPublishedAt });
    if (!updated) throw new NotFoundException("Project not found");

    const now = new Date();
    const [grantCountRow] = await this.db
      .select({ count: count() })
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, u.orgId),
          eq(projectClientGrants.projectId, projectId),
          eq(projectClientGrants.status, "ACTIVE"),
          or(isNull(projectClientGrants.expiresAt), gt(projectClientGrants.expiresAt, now)),
        ),
      )
      .limit(1);

    return {
      portalPublishedAt: updated.portalPublishedAt,
      grantCount: grantCountRow?.count ?? 0,
    };
  }

  async unpublishPortal(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [updated] = await this.db
      .update(projects)
      .set({ portalPublishedAt: null })
      .where(and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)))
      .returning({ portalPublishedAt: projects.portalPublishedAt });
    if (!updated) throw new NotFoundException("Project not found");

    return {
      portalPublishedAt: updated.portalPublishedAt,
      grantCount: 0,
    };
  }
}
