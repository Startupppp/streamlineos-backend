import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  incidentUpdates,
  incidentDecisions,
  incidentFollowUpActions,
  projectIncidents,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "../core/project-access";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { UNRESOLVED_FOLLOW_UP_STATUSES } from "./dto/incidents.schemas";
import type {
  AddIncidentDecisionInput,
  AddIncidentUpdateInput,
  CreateFollowUpActionInput,
  CreateIncidentInput,
  ListIncidentsQuery,
  UpdateFollowUpActionInput,
  UpdateIncidentInput,
} from "./dto/incidents.schemas";

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

type IncidentRow = typeof projectIncidents.$inferSelect;
type IncidentPatch = Partial<typeof projectIncidents.$inferInsert>;
type SlaFields = Pick<IncidentPatch, "respondedAt" | "resolvedAt">;

@Injectable()
export class IncidentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

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

  async listIncidents(u: CurrentUserContext, projectId: number, query: ListIncidentsQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.db
      .select()
      .from(projectIncidents)
      .where(
        and(
          eq(projectIncidents.orgId, u.orgId),
          eq(projectIncidents.projectId, projectId),
          isNull(projectIncidents.deletedAt),
          query.status ? eq(projectIncidents.status, query.status) : undefined,
          query.severity ? eq(projectIncidents.severity, query.severity) : undefined,
        ),
      )
      .orderBy(sql`${projectIncidents.detectedAt} DESC NULLS LAST`)
      .limit(100);
  }

  async getIncident(u: CurrentUserContext, projectId: number, incidentId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const incident = await this.loadIncident(u.orgId, projectId, incidentId);
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
      .where(and(eq(incidentUpdates.incidentId, incidentId), eq(incidentUpdates.orgId, u.orgId)))
      .orderBy(desc(incidentUpdates.createdAt))
      .limit(100);
    const decisions = await this.db
      .select()
      .from(incidentDecisions)
      .where(and(eq(incidentDecisions.incidentId, incidentId), eq(incidentDecisions.orgId, u.orgId)))
      .orderBy(desc(incidentDecisions.createdAt))
      .limit(100);
    const followUpActions = await this.db
      .select()
      .from(incidentFollowUpActions)
      .where(
        and(
          eq(incidentFollowUpActions.incidentId, incidentId),
          eq(incidentFollowUpActions.orgId, u.orgId),
          isNull(incidentFollowUpActions.deletedAt),
        ),
      )
      .orderBy(desc(incidentFollowUpActions.createdAt))
      .limit(100);
    return { ...incident, updates, decisions, followUpActions };
  }

  async createIncident(u: CurrentUserContext, projectId: number, input: CreateIncidentInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [incident] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectIncidents.incidentNumber}), 0)` })
        .from(projectIncidents)
        .where(and(eq(projectIncidents.projectId, projectId), eq(projectIncidents.orgId, u.orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      return tx.insert(projectIncidents).values({
        orgId: u.orgId,
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
        releaseId: input.releaseId ?? null,
        createdBy: u.userId,
      }).returning();
    });
    if (!incident) throw new NotFoundException("Failed to create incident");
    this.audit.log({
      action: "incident.created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_incident",
      resourceId: String(incident.id),
      metadata: { projectId, incidentId: incident.id, title: incident.title },
    });
    return incident;
  }

  async updateIncident(
    u: CurrentUserContext,
    projectId: number,
    incidentId: number,
    input: UpdateIncidentInput,
  ) {
    const current = await this.loadIncident(u.orgId, projectId, incidentId);
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
    if (input.releaseId !== undefined) patch.releaseId = input.releaseId ?? null;
    if (input.status !== undefined) {
      patch.status = input.status;
      Object.assign(patch, this.computeSla(current, input.status));
    }

    const now = new Date();
    const closing = input.status === "closed" && current.status !== "closed";

    const [updated] = await this.db.transaction(async (tx) => {
      let waivedFollowUpCount = 0;
      if (closing) {
        const [unresolved] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(incidentFollowUpActions)
          .where(
            and(
              eq(incidentFollowUpActions.orgId, u.orgId),
              eq(incidentFollowUpActions.incidentId, incidentId),
              isNull(incidentFollowUpActions.deletedAt),
              inArray(incidentFollowUpActions.status, [...UNRESOLVED_FOLLOW_UP_STATUSES]),
            ),
          );
        waivedFollowUpCount = unresolved?.count ?? 0;
        if (waivedFollowUpCount > 0 && input.followUpWaiverReason === undefined)
          throw new ConflictException(
            `Cannot close incident with ${waivedFollowUpCount} unresolved follow-up action(s). Resolve them or supply followUpWaiverReason.`,
          );
      }

      const rows = await tx
        .update(projectIncidents)
        .set(patch)
        .where(
          and(
            eq(projectIncidents.id, incidentId),
            eq(projectIncidents.orgId, u.orgId),
            eq(projectIncidents.projectId, projectId),
          ),
        )
        .returning();

      if (input.status !== undefined && input.status !== current.status) {
        await tx.insert(incidentUpdates).values({
          orgId: u.orgId,
          incidentId,
          message: `Status changed to ${input.status}`,
          newStatus: input.status,
          createdBy: u.userId,
        });
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: u.orgId,
          aggregateType: "incident",
          aggregateId: String(incidentId),
          aggregateVersion: now.getTime(),
          eventType: "build.incident.status_changed",
          payload: {
            incidentId,
            projectId,
            orgId: u.orgId,
            oldStatus: current.status,
            newStatus: input.status,
          },
          occurredAt: now,
        });
      }

      if (closing && waivedFollowUpCount > 0 && input.followUpWaiverReason !== undefined) {
        await tx.insert(incidentUpdates).values({
          orgId: u.orgId,
          incidentId,
          message: `Closed with ${waivedFollowUpCount} unresolved follow-up action(s) waived: ${input.followUpWaiverReason}`,
          newStatus: null,
          createdBy: u.userId,
        });
      }

      if (
        input.severity !== undefined &&
        (SEVERITY_RANK[input.severity] ?? 2) < (SEVERITY_RANK[current.severity] ?? 2)
      ) {
        await tx.insert(incidentUpdates).values({
          orgId: u.orgId,
          incidentId,
          message: `Severity escalated to ${input.severity}`,
          newStatus: null,
          createdBy: u.userId,
        });
      }

      return rows;
    });

    if (!updated) throw new NotFoundException("Incident not found");
    this.audit.log({
      action: "incident.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: {
        projectId,
        incidentId,
        ...(closing && input.followUpWaiverReason !== undefined
          ? { followUpWaiverReason: input.followUpWaiverReason }
          : {}),
      },
    });
    return updated;
  }

  async deleteIncident(u: CurrentUserContext, projectId: number, incidentId: number) {
    await this.loadIncident(u.orgId, projectId, incidentId);
    await this.db
      .update(projectIncidents)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(projectIncidents.id, incidentId),
          eq(projectIncidents.orgId, u.orgId),
          eq(projectIncidents.projectId, projectId),
        ),
      );
    this.audit.log({
      action: "incident.deleted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: { projectId, incidentId },
    });
  }

  async addUpdate(
    u: CurrentUserContext,
    projectId: number,
    incidentId: number,
    input: AddIncidentUpdateInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const current = await this.loadIncident(u.orgId, projectId, incidentId);

    if (current.status === "closed" && input.newStatus !== undefined && input.newStatus !== "closed") {
      throw new ConflictException("Cannot transition a closed incident");
    }

    const now = new Date();

    const [update] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(incidentUpdates).values({
        orgId: u.orgId,
        incidentId,
        message: input.message,
        newStatus: input.newStatus ?? null,
        createdBy: u.userId,
      }).returning();

      if (input.newStatus !== undefined && input.newStatus !== current.status) {
        const sla = this.computeSla(current, input.newStatus);
        await tx
          .update(projectIncidents)
          .set({ status: input.newStatus, ...sla })
          .where(
            and(
              eq(projectIncidents.id, incidentId),
              eq(projectIncidents.orgId, u.orgId),
              eq(projectIncidents.projectId, projectId),
            ),
          );
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: u.orgId,
          aggregateType: "incident",
          aggregateId: String(incidentId),
          aggregateVersion: now.getTime(),
          eventType: "build.incident.status_changed",
          payload: {
            incidentId,
            projectId,
            orgId: u.orgId,
            oldStatus: current.status,
            newStatus: input.newStatus,
          },
          occurredAt: now,
        });
      }

      return rows;
    });

    this.audit.log({
      action: "incident.update_added",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: { projectId, incidentId, updateId: update?.id },
    });
    return update;
  }

  /**
   * Postmortem field: decisions. An append-only log — insert + list, same
   * shape as `addUpdate` above minus the status-transition side effects,
   * because a decision does not itself move the incident's lifecycle state.
   */
  async addDecision(
    u: CurrentUserContext,
    projectId: number,
    incidentId: number,
    input: AddIncidentDecisionInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    await this.loadIncident(u.orgId, projectId, incidentId);

    const [decision] = await this.db
      .insert(incidentDecisions)
      .values({
        orgId: u.orgId,
        incidentId,
        decision: input.decision,
        rationale: input.rationale ?? null,
        decidedBy: u.userId,
      })
      .returning();

    this.audit.log({
      action: "incident.decision_added",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: { projectId, incidentId, decisionId: decision?.id },
    });
    return decision;
  }

  /**
   * Postmortem field: follow-up actions. No closed-incident guard — the
   * normal time to record these is the postmortem itself, which runs after
   * the incident is closed.
   */
  async addFollowUpAction(
    u: CurrentUserContext,
    projectId: number,
    incidentId: number,
    input: CreateFollowUpActionInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    await this.loadIncident(u.orgId, projectId, incidentId);

    const [action] = await this.db
      .insert(incidentFollowUpActions)
      .values({
        orgId: u.orgId,
        incidentId,
        title: input.title,
        description: input.description ?? null,
        ownerId: input.ownerId ?? null,
        dueAt: input.dueAt ?? null,
        createdBy: u.userId,
      })
      .returning();

    this.audit.log({
      action: "incident.follow_up_action_added",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: { projectId, incidentId, followUpActionId: action?.id },
    });
    return action;
  }

  async updateFollowUpAction(
    u: CurrentUserContext,
    projectId: number,
    incidentId: number,
    followUpActionId: number,
    input: UpdateFollowUpActionInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    await this.loadIncident(u.orgId, projectId, incidentId);

    const patch: Partial<typeof incidentFollowUpActions.$inferInsert> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.ownerId !== undefined) patch.ownerId = input.ownerId ?? null;
    if (input.status !== undefined) patch.status = input.status;
    if (input.dueAt !== undefined) patch.dueAt = input.dueAt ?? null;

    const [updated] = await this.db
      .update(incidentFollowUpActions)
      .set(patch)
      .where(
        and(
          eq(incidentFollowUpActions.id, followUpActionId),
          eq(incidentFollowUpActions.orgId, u.orgId),
          eq(incidentFollowUpActions.incidentId, incidentId),
          isNull(incidentFollowUpActions.deletedAt),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Follow-up action not found");

    this.audit.log({
      action: "incident.follow_up_action_updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: { projectId, incidentId, followUpActionId },
    });
    return updated;
  }
}
