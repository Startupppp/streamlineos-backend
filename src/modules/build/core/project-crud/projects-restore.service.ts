import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  projectTemplates,
  projects,
  ticketComments,
  tickets,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { BuildRestoreResult } from "../dto/build-core-response.schemas";

@Injectable()
export class ProjectsRestoreService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async restoreProject(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<BuildRestoreResult> {
    const orgId = u.orgId;
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: {
        id: true,
        name: true,
        key: true,
        intakeToken: true,
        deletedAt: true,
      },
    });
    if (!project) throw new NotFoundException("Project not found");
    const deletedAt = project.deletedAt;
    if (!deletedAt) throw new ConflictException("Project is not deleted");

    const occupant = await this.db
      .select({ id: projects.id, key: projects.key })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, orgId),
          ne(projects.id, projectId),
          isNull(projects.deletedAt),
          or(
            eq(projects.key, project.key),
            eq(projects.intakeToken, project.intakeToken),
          ),
        ),
      )
      .limit(1);
    if (occupant[0])
      throw new ConflictException(
        `Project key "${project.key}" is already held by live project ${String(occupant[0].id)}. Rename or delete that project before restoring this one.`,
      );

    const restoredChildren = await this.db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({ deletedAt: null })
        .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));

      const restoredTickets = await tx
        .update(tickets)
        .set({ deletedAt: null })
        .where(
          and(
            eq(tickets.orgId, orgId),
            eq(tickets.projectId, projectId),
            eq(tickets.deletedAt, deletedAt),
          ),
        )
        .returning({ id: tickets.id });

      let restoredComments = 0;
      if (restoredTickets.length > 0) {
        const commentRows = await tx
          .update(ticketComments)
          .set({ deletedAt: null })
          .where(
            and(
              eq(ticketComments.orgId, orgId),
              inArray(
                ticketComments.ticketId,
                restoredTickets.map((t) => t.id),
              ),
              eq(ticketComments.deletedAt, deletedAt),
            ),
          )
          .returning({ id: ticketComments.id });
        restoredComments = commentRows.length;
      }

      await this.audit.logCritical({
        action: "project.restored",
        userId: u.userId,
        orgId,
        targetId: String(projectId),
        targetType: "project",
        metadata: {
          name: project.name,
          restoredTickets: restoredTickets.length,
          restoredComments,
          deletedAt: deletedAt.toISOString(),
        },
      });

      return restoredTickets.length + restoredComments;
    });

    void this.cache
      .invalidateNamespace(`build:analytics:${orgId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId, projectId }));

    return { restored: true, restoredChildren };
  }

  async restoreTemplate(
    u: CurrentUserContext,
    templateId: number,
  ): Promise<BuildRestoreResult> {
    const orgId = u.orgId;
    const template = await this.db.query.projectTemplates.findFirst({
      where: and(
        eq(projectTemplates.id, templateId),
        eq(projectTemplates.orgId, orgId),
      ),
      columns: { id: true, name: true, deletedAt: true },
    });
    if (!template) throw new NotFoundException("Template not found");
    if (!template.deletedAt)
      throw new ConflictException("Template is not deleted");

    await this.db
      .update(projectTemplates)
      .set({ deletedAt: null })
      .where(
        and(
          eq(projectTemplates.orgId, orgId),
          eq(projectTemplates.id, templateId),
        ),
      );

    await this.audit.logCritical({
      action: "build.template.restored",
      userId: u.userId,
      orgId,
      targetId: String(templateId),
      targetType: "project_template",
      metadata: { name: template.name },
    });

    return { restored: true, restoredChildren: 0 };
  }
}
