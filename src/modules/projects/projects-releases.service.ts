import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  projectReleases,
  releaseTickets,
  tickets,
  projects,
} from "../../db/schema";
import type { CreateReleaseInput, UpdateReleaseInput } from "./dto/releases.schemas";

@Injectable()
export class ProjectsReleasesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listReleases(orgId: string, projectId: number) {
    const rows = await this.db.query.projectReleases.findMany({
      where: and(eq(projectReleases.projectId, projectId), eq(projectReleases.orgId, orgId)),
      with: { tickets: true },
      orderBy: (r, { desc }) => [desc(r.createdAt)],
    });
    return rows.map((r) => ({ ...r, ticketCount: r.tickets.length }));
  }

  async createRelease(orgId: string, projectId: number, userId: string, data: CreateReleaseInput) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!project) throw new NotFoundException("Project not found");

    const [release] = await this.db.insert(projectReleases).values({
      orgId,
      projectId,
      createdBy: userId,
      ...data,
    }).returning();
    return release;
  }

  async updateRelease(orgId: string, releaseId: number, data: UpdateReleaseInput) {
    const [updated] = await this.db.update(projectReleases)
      .set(data)
      .where(and(eq(projectReleases.id, releaseId), eq(projectReleases.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Release not found");
    return updated;
  }

  async deleteRelease(orgId: string, releaseId: number) {
    const [deleted] = await this.db.delete(projectReleases)
      .where(and(eq(projectReleases.id, releaseId), eq(projectReleases.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Release not found");
    return { success: true };
  }

  async addTicketToRelease(orgId: string, releaseId: number, ticketId: number) {
    const release = await this.db.query.projectReleases.findFirst({
      where: and(eq(projectReleases.id, releaseId), eq(projectReleases.orgId, orgId)),
      columns: { id: true },
    });
    if (!release) throw new NotFoundException("Release not found");

    await this.db.insert(releaseTickets).values({ releaseId, ticketId }).onConflictDoNothing();
    return { success: true };
  }

  async removeTicketFromRelease(orgId: string, releaseId: number, ticketId: number) {
    await this.db.delete(releaseTickets)
      .where(and(eq(releaseTickets.releaseId, releaseId), eq(releaseTickets.ticketId, ticketId)));
    return { success: true };
  }
}
