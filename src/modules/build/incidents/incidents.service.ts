import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  incidentUpdates,
  incidentDecisions,
  incidentFollowUpActions,
  projectIncidents,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "../core/project-access";
import { UNRESOLVED_FOLLOW_UP_STATUSES } from "./dto/incidents.schemas";
import type {
  AddIncidentDecisionInput,
  AddIncidentUpdateInput,
  CreateFollowUpActionInput,
  CreateIncidentInput,
  IncidentChildrenQuery,
  ListIncidentsQuery,
  UpdateFollowUpActionInput,
  UpdateIncidentInput,
} from "./dto/incidents.schemas";
import { loadIncidentChildren } from "./incident-children";
import { buildTupleCursorPage, decodeTupleCursor } from "../../../common/pagination/cursor";

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const NULL_DETECTED_AT = "__NULL_DETECTED_AT__";
const INCIDENT_PAGE_SIZE = 100;

function decodeIncidentCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  const parts = decodeTupleCursor(cursor, 2);
  if (!parts) throw new BadRequestException("Invalid pagination cursor");
  const [detectedAtValue, idValue] = parts;
  const id = Number(idValue);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new BadRequestException("Invalid pagination cursor");
  }
  if (detectedAtValue === NULL_DETECTED_AT) return { id, detectedAt: null };
  const detectedAt = new Date(detectedAtValue);
  if (Number.isNaN(detectedAt.getTime()) || detectedAt.toISOString() !== detectedAtValue) {
    throw new BadRequestException("Invalid pagination cursor");
  }
  return { id, detectedAt };
}

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

  private async enforceClosePolicy(
    tx: TenantTx,
    orgId: string,
    incidentId: number,
    waiverReason: string | undefined,
  ): Promise<number> {
    const [unresolved] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(incidentFollowUpActions)
      .where(
        and(
          eq(incidentFollowUpActions.orgId, orgId),
          eq(incidentFollowUpActions.incidentId, incidentId),
          isNull(incidentFollowUpActions.deletedAt),
          inArray(incidentFollowUpActions.status, [...UNRESOLVED_FOLLOW_UP_STATUSES]),
        ),
      );
    const count = unresolved?.count ?? 0;
    if (count > 0 && !waiverReason)
      throw new ConflictException(
        `Cannot close incident with ${count} unresolved follow-up action(s). Resolve them or supply followUpWaiverReason.`,
      );
    return count;
  }

  async listIncidents(u: CurrentUserContext, projectId: number, query: ListIncidentsQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const cursor = decodeIncidentCursor(query.cursor);
    const rows = await this.db
      .select()
      .from(projectIncidents)
      .where(
        and(
          eq(projectIncidents.orgId, u.orgId),
          eq(projectIncidents.projectId, projectId),
          isNull(projectIncidents.deletedAt),
          query.status ? eq(projectIncidents.status, query.status) : undefined,
          query.severity ? eq(projectIncidents.severity, query.severity) : undefined,
          query.q
            ? sql`to_tsvector('english', coalesce(${projectIncidents.title}, '')) @@ plainto_tsquery('english', ${query.q})`
            : undefined,
          cursor
            ? cursor.detectedAt
              ? or(
                  lt(projectIncidents.detectedAt, cursor.detectedAt),
                  and(eq(projectIncidents.detectedAt, cursor.detectedAt), lt(projectIncidents.id, cursor.id)),
                  isNull(projectIncidents.detectedAt),
                )
              : and(isNull(projectIncidents.detectedAt), lt(projectIncidents.id, cursor.id))
            : undefined,
        ),
      )
      .orderBy(sql`${projectIncidents.detectedAt} DESC NULLS LAST`, desc(projectIncidents.id))
      .limit(INCIDENT_PAGE_SIZE + 1);
    return buildTupleCursorPage(rows, INCIDENT_PAGE_SIZE, (row) => [
      row.detectedAt?.toISOString() ?? NULL_DETECTED_AT,
      String(row.id),
    ]);
  }

  async getIncident(
    u: CurrentUserContext,
    projectId: number,
    incidentId: number,
    query: IncidentChildrenQuery = { limit: 100 },
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const incident = await this.loadIncident(u.orgId, projectId, incidentId);
    return { ...incident, ...(await loadIncidentChildren(this.db, u.orgId, incidentId, query)) };
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
    await assertProjectAccess(this.db, this.access, u, projectId);
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
    const followUpWaiverReason = input.followUpWaiverReason?.trim() || undefined;

    const [updated] = await this.db.transaction(async (tx) => {
      let waivedFollowUpCount = 0;
      if (closing)
        waivedFollowUpCount = await this.enforceClosePolicy(
          tx,
          u.orgId,
          incidentId,
          followUpWaiverReason,
        );

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
      }

      if (closing && waivedFollowUpCount > 0 && followUpWaiverReason !== undefined) {
        await tx.insert(incidentUpdates).values({
          orgId: u.orgId,
          incidentId,
          message: `Closed with ${waivedFollowUpCount} unresolved follow-up action(s) waived: ${followUpWaiverReason}`,
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
        ...(closing && followUpWaiverReason !== undefined
          ? { followUpWaiverReason }
          : {}),
      },
    });
    return updated;
  }

  async deleteIncident(u: CurrentUserContext, projectId: number, incidentId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
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
    const closing = input.newStatus === "closed" && current.status !== "closed";
    const followUpWaiverReason = input.followUpWaiverReason?.trim() || undefined;

    const [update] = await this.db.transaction(async (tx) => {
      const waivedFollowUpCount = closing
        ? await this.enforceClosePolicy(tx, u.orgId, incidentId, followUpWaiverReason)
        : 0;
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
      }

      if (closing && waivedFollowUpCount > 0 && followUpWaiverReason !== undefined)
        await tx.insert(incidentUpdates).values({
          orgId: u.orgId,
          incidentId,
          message: `Closed with ${waivedFollowUpCount} unresolved follow-up action(s) waived: ${followUpWaiverReason}`,
          newStatus: null,
          createdBy: u.userId,
        });

      return rows;
    });

    this.audit.log({
      action: "incident.update_added",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_incident",
      resourceId: String(incidentId),
      metadata: {
        projectId,
        incidentId,
        updateId: update?.id,
        ...(closing && followUpWaiverReason !== undefined ? { followUpWaiverReason } : {}),
      },
    });
    return update;
  }

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
