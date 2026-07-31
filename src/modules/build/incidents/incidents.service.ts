import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { incidentUpdates, projectIncidents, projects, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  AddIncidentUpdateInput,
  CreateIncidentInput,
  ListIncidentsQuery,
  UpdateIncidentInput,
} from "./dto/incidents.schemas";

type IncidentRow = typeof projectIncidents.$inferSelect;
type IncidentPatch = Partial<typeof projectIncidents.$inferInsert>;
type SlaFields = Pick<IncidentPatch, "respondedAt" | "resolvedAt">;

@Injectable()
export class IncidentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async assertProject(orgId: string, projectId: number): Promise<void> {
    const p = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!p) throw new NotFoundException("Project not found");
  }

  private async loadIncident(orgId: string, projectId: number, incidentId: number): Promise<IncidentRow> {
    const row = await this.db.query.projectIncidents.findFirst({
      where: and(
        eq(projectIncidents.id, incidentId),
        eq(projectIncidents.orgId, orgId),
        eq(projectIncidents.projectId, projectId),
        isNull(projectIncidents.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Incident not found");
    return row;
  }

  private computeSla(current: Pick<IncidentRow, "respondedAt" | "resolvedAt">, newStatus: string): SlaFields {
    const patch: SlaFields = {};
    const now = new Date();
    if (newStatus !== "detected" && !current.respondedAt) patch.respondedAt = now;
    if (newStatus === "resolved" && !current.resolvedAt) patch.resolvedAt = now;
    return patch;
  }

  async listIncidents(orgId: string, projectId: number, query: ListIncidentsQuery) {
    await this.assertProject(orgId, projectId);
    return this.db
      .select()
      .from(projectIncidents)
      .where(
        and(
          eq(projectIncidents.orgId, orgId),
          eq(projectIncidents.projectId, projectId),
          isNull(projectIncidents.deletedAt),
          query.status ? eq(projectIncidents.status, query.status) : undefined,
          query.severity ? eq(projectIncidents.severity, query.severity) : undefined,
        ),
      )
      .orderBy(sql`${projectIncidents.detectedAt} DESC NULLS LAST`)
      .limit(100);
  }

  async getIncident(orgId: string, projectId: number, incidentId: number) {
    const incident = await this.loadIncident(orgId, projectId, incidentId);
    const updates = await this.db
      .select({
        id: incidentUpdates.id,
        orgId: incidentUpdates.orgId,
        incidentId: incidentUpdates.incidentId,
        message: incidentUpdates.message,
        newStatus: incidentUpdates.newStatus,
        createdBy: incidentUpdates.createdBy,
        createdAt: incidentUpdates.createdAt,
        createdByName: users.name,
        createdByEmail: users.email,
      })
      .from(incidentUpdates)
      .leftJoin(users, eq(users.id, incidentUpdates.createdBy))
      .where(and(eq(incidentUpdates.incidentId, incidentId), eq(incidentUpdates.orgId, orgId)))
      .orderBy(desc(incidentUpdates.createdAt));
    return { ...incident, updates };
  }

  async createIncident(orgId: string, userId: string, projectId: number, input: CreateIncidentInput) {
    await this.assertProject(orgId, projectId);
    const [incident] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectIncidents.incidentNumber}), 0)` })
        .from(projectIncidents)
        .where(and(eq(projectIncidents.projectId, projectId), eq(projectIncidents.orgId, orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      return tx.insert(projectIncidents).values({
        orgId,
        projectId,
        incidentNumber: nextNumber,
        title: input.title,
        description: input.description ?? null,
        severity: input.severity ?? "medium",
        status: input.status ?? "detected",
        impact: input.impact ?? null,
        ownerId: input.ownerId ?? null,
        rootCause: input.rootCause ?? null,
        customerComms: input.customerComms ?? null,
        detectedAt: input.detectedAt ?? new Date(),
        responseDueAt: input.responseDueAt ?? null,
        resolutionDueAt: input.resolutionDueAt ?? null,
        linkedTicketId: input.linkedTicketId ?? null,
        createdBy: userId,
      }).returning();
    });
    if (!incident) throw new NotFoundException("Failed to create incident");
    this.audit.log({
      action: "incident.created",
      userId,
      orgId,
      resourceType: "project_incident",
      resourceId: String(incident.id),
      metadata: { projectId, incidentId: incident.id, title: incident.title },
    });
    return incident;
  }

  async updateIncident(
    orgId: string,
    userId: string,
    projectId: number,
    incidentId: number,
    input: UpdateIncidentInput,
  ) {
    const current = await this.loadIncident(orgId, projectId, incidentId);
    const patch: IncidentPatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.severity !== undefined) patch.severity = input.severity;
    if (input.impact !== undefined) patch.impact = input.impact ?? null;
    if (input.ownerId !== undefined) patch.ownerId = input.ownerId ?? null;
    if (input.rootCause !== undefined) patch.rootCause = input.rootCause ?? null;
    if (input.customerComms !== undefined) patch.customerComms = input.customerComms ?? null;
    if (input.detectedAt !== undefined) patch.detectedAt = input.detectedAt ?? null;
    if (input.responseDueAt !== undefined) patch.responseDueAt = input.responseDueAt ?? null;
    if (input.resolutionDueAt !== undefined) patch.resolutionDueAt = input.resolutionDueAt ?? null;
    if (input.linkedTicketId !== undefined) patch.linkedTicketId = input.linkedTicketId ?? null;
    if (input.status !== undefined) {
      patch.status = input.status;
      Object.assign(patch, this.computeSla(current, input.status));
    }
    const [updated] = await this.db
      .update(projectIncidents)
      .set(patch)
      .where(and(eq(projectIncidents.id, incidentId), eq(projectIncidents.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Incident not found");
    this.audit.log({
      action: "incident.updated",
      userId,
      orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: { projectId, incidentId },
    });
    return updated;
  }

  async deleteIncident(orgId: string, userId: string, projectId: number, incidentId: number) {
    await this.loadIncident(orgId, projectId, incidentId);
    await this.db
      .update(projectIncidents)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectIncidents.id, incidentId), eq(projectIncidents.orgId, orgId)));
    this.audit.log({
      action: "incident.deleted",
      userId,
      orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: { projectId, incidentId },
    });
  }

  async addUpdate(
    orgId: string,
    userId: string,
    projectId: number,
    incidentId: number,
    input: AddIncidentUpdateInput,
  ) {
    const current = await this.loadIncident(orgId, projectId, incidentId);
    const [update] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(incidentUpdates).values({
        orgId,
        incidentId,
        message: input.message,
        newStatus: input.newStatus ?? null,
        createdBy: userId,
      }).returning();
      if (input.newStatus) {
        const sla = this.computeSla(current, input.newStatus);
        await tx
          .update(projectIncidents)
          .set({ status: input.newStatus, ...sla })
          .where(and(eq(projectIncidents.id, incidentId), eq(projectIncidents.orgId, orgId)));
      }
      return rows;
    });
    this.audit.log({
      action: "incident.update_added",
      userId,
      orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: { projectId, incidentId, updateId: update?.id },
    });
    return update;
  }
}
