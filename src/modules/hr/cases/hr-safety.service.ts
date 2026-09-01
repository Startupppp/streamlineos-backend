import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  avg,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  decodeCursor,
  buildCursorPage,
} from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrSafetyIncidents,
  hrWellnessCheckins,
} from "../../../db/schema/hr/safety";
import { HrAuditService } from "../core/hr-audit.service";
import type {
  CreateIncidentInput,
  UpdateIncidentInput,
  ListIncidentsInput,
  CheckinInput,
  WellnessTrendInput,
} from "./dto/hr-safety.schemas";

const SAFETY_SEARCH_CAP = 500;
const BURNOUT_SCORE_THRESHOLD = 4;
const WELLNESS_MIN_GROUP_SIZE = 5;

function generateIncidentNumber(): string {
  const year = new Date().getFullYear();
  const suffix = Math.random().toString(36).toUpperCase().slice(2, 8);
  return `INC-${year}-${suffix}`;
}

@Injectable()
export class HrSafetyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async listIncidents(orgId: string, input: ListIncidentsInput) {
    const { cursor, limit, status, type, severity, search, fromDate, toDate } =
      input;
    const pos = decodeCursor(cursor);

    const conditions = [
      eq(hrSafetyIncidents.orgId, orgId),
      isNull(hrSafetyIncidents.deletedAt),
    ];

    if (status) conditions.push(eq(hrSafetyIncidents.status, status));
    if (type) conditions.push(eq(hrSafetyIncidents.type, type));
    if (severity) conditions.push(eq(hrSafetyIncidents.severity, severity));
    if (search) conditions.push(await this.incidentSearchCondition(search));
    if (fromDate)
      conditions.push(gte(hrSafetyIncidents.occurredAt, new Date(fromDate)));
    if (toDate)
      conditions.push(lte(hrSafetyIncidents.occurredAt, new Date(toDate)));
    if (pos)
      conditions.push(
        keysetBeforeId(hrSafetyIncidents.occurredAt, hrSafetyIncidents.id, pos),
      );

    const rows = await this.db
      .select({
        id: hrSafetyIncidents.id,
        incidentNumber: hrSafetyIncidents.incidentNumber,
        type: hrSafetyIncidents.type,
        location: hrSafetyIncidents.location,
        occurredAt: hrSafetyIncidents.occurredAt,
        reportedBy: hrSafetyIncidents.reportedBy,
        severity: hrSafetyIncidents.severity,
        status: hrSafetyIncidents.status,
        medicalAttention: hrSafetyIncidents.medicalAttention,
        createdAt: hrSafetyIncidents.createdAt,
        description: hrSafetyIncidents.description,
      })
      .from(hrSafetyIncidents)
      .where(and(...conditions))
      .orderBy(desc(hrSafetyIncidents.occurredAt), desc(hrSafetyIncidents.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.occurredAt.toISOString(),
      id: String(row.id),
    }));
  }

  private async incidentSearchCondition(search: string): Promise<SQL> {
    const fallback = or(
      ilike(hrSafetyIncidents.description, `%${search}%`),
      ilike(hrSafetyIncidents.incidentNumber, `%${search}%`),
      ilike(hrSafetyIncidents.location, `%${search}%`),
    )!;
    const rows = await this.db.execute(
      sql`SELECT app.search_hr_safety_incident_ids(${search}, ${SAFETY_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return sql`false`;
    if (rows.length > SAFETY_SEARCH_CAP) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(hrSafetyIncidents.id, ids);
  }

  async getIncidentById(orgId: string, id: number, hasSensitive: boolean) {
    const [row] = await this.db
      .select()
      .from(hrSafetyIncidents)
      .where(
        and(
          eq(hrSafetyIncidents.orgId, orgId),
          eq(hrSafetyIncidents.id, id),
          isNull(hrSafetyIncidents.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Incident not found");

    if (!hasSensitive) {
      return { ...row, confidentialMedicalNote: null };
    }

    return row;
  }

  async createIncident(
    orgId: string,
    userId: string,
    input: CreateIncidentInput,
    ipAddress?: string,
  ) {
    const incidentNumber = generateIncidentNumber();

    const [incident] = await this.db
      .insert(hrSafetyIncidents)
      .values({
        orgId,
        incidentNumber,
        type: input.type,
        location: input.location,
        occurredAt: new Date(input.occurredAt),
        reportedBy: userId,
        description: input.description,
        severity: input.severity,
        status: "open",
        medicalAttention: input.medicalAttention ?? false,
        confidentialMedicalNote: input.confidentialMedicalNote ?? null,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_safety_incident",
      entityId: String(incident!.id),
      action: "safety.incident_created",
      after: { incidentNumber, type: input.type, severity: input.severity },
      ipAddress,
    });

    return incident!;
  }

  async updateIncident(
    orgId: string,
    id: number,
    userId: string,
    hasSensitive: boolean,
    input: UpdateIncidentInput,
    ipAddress?: string,
  ) {
    const existing = await this.getIncidentById(orgId, id, hasSensitive);

    if (input.confidentialMedicalNote !== undefined && !hasSensitive) {
      throw new ForbiddenException(
        "Requires hr:sensitive:view to update medical notes",
      );
    }

    const [updated] = await this.db
      .update(hrSafetyIncidents)
      .set({
        ...(input.status !== undefined && { status: input.status }),
        ...(input.severity !== undefined && { severity: input.severity }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.medicalAttention !== undefined && {
          medicalAttention: input.medicalAttention,
        }),
        ...(input.confidentialMedicalNote !== undefined && {
          confidentialMedicalNote: input.confidentialMedicalNote,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(eq(hrSafetyIncidents.orgId, orgId), eq(hrSafetyIncidents.id, id)),
      )
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_safety_incident",
      entityId: String(id),
      action: "safety.incident_updated",
      before: { status: existing.status },
      after: { status: input.status },
      ipAddress,
    });

    return updated!;
  }

  async deleteIncident(orgId: string, id: number, userId: string) {
    const [row] = await this.db
      .select({ id: hrSafetyIncidents.id })
      .from(hrSafetyIncidents)
      .where(
        and(
          eq(hrSafetyIncidents.orgId, orgId),
          eq(hrSafetyIncidents.id, id),
          isNull(hrSafetyIncidents.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Incident not found");

    await this.db
      .update(hrSafetyIncidents)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(hrSafetyIncidents.orgId, orgId), eq(hrSafetyIncidents.id, id)),
      );

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_safety_incident",
      entityId: String(id),
      action: "safety.incident_deleted",
    });
  }

  async upsertCheckin(orgId: string, userId: string, input: CheckinInput) {
    const [row] = await this.db
      .insert(hrWellnessCheckins)
      .values({
        orgId,
        userId,
        date: input.date,
        score: input.score,
        flags: input.flags ?? null,
      })
      .onConflictDoUpdate({
        target: [
          hrWellnessCheckins.orgId,
          hrWellnessCheckins.userId,
          hrWellnessCheckins.date,
        ],
        set: {
          score: input.score,
          flags: input.flags ?? null,
        },
      })
      .returning();

    return row!;
  }

  async myCheckins(
    orgId: string,
    userId: string,
    fromDate?: string,
    toDate?: string,
  ) {
    const conditions = [
      eq(hrWellnessCheckins.orgId, orgId),
      eq(hrWellnessCheckins.userId, userId),
    ];

    if (fromDate) conditions.push(gte(hrWellnessCheckins.date, fromDate));
    if (toDate) conditions.push(lte(hrWellnessCheckins.date, toDate));

    return this.db
      .select()
      .from(hrWellnessCheckins)
      .where(and(...conditions))
      .orderBy(desc(hrWellnessCheckins.date))
      .limit(90);
  }

  async orgWellnessTrend(orgId: string, input: WellnessTrendInput) {
    const conditions = [eq(hrWellnessCheckins.orgId, orgId)];

    if (input.fromDate)
      conditions.push(gte(hrWellnessCheckins.date, input.fromDate));
    if (input.toDate)
      conditions.push(lte(hrWellnessCheckins.date, input.toDate));

    const rows = await this.db
      .select({
        date: hrWellnessCheckins.date,
        avgScore: avg(hrWellnessCheckins.score),
        respondents: count(hrWellnessCheckins.userId),
      })
      .from(hrWellnessCheckins)
      .where(and(...conditions))
      .groupBy(hrWellnessCheckins.date)
      .orderBy(hrWellnessCheckins.date)
      .limit(90);

    return rows
      .filter((r) => (r.respondents ?? 0) >= WELLNESS_MIN_GROUP_SIZE)
      .map((r) => ({
        date: r.date,
        avgScore: r.avgScore !== null ? parseFloat(String(r.avgScore)) : null,
        respondents: r.respondents,
      }));
  }

  async burnoutFlags(orgId: string) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const rows = await this.db
      .select({
        userId: hrWellnessCheckins.userId,
        avgScore: avg(hrWellnessCheckins.score),
        checkCount: count(hrWellnessCheckins.id),
      })
      .from(hrWellnessCheckins)
      .where(
        and(
          eq(hrWellnessCheckins.orgId, orgId),
          gte(hrWellnessCheckins.date, cutoffStr),
        ),
      )
      .groupBy(hrWellnessCheckins.userId);

    return rows
      .filter(
        (r) =>
          r.avgScore !== null &&
          parseFloat(String(r.avgScore)) <= BURNOUT_SCORE_THRESHOLD,
      )
      .map((r) => ({
        userId: r.userId,
        avgScore: parseFloat(String(r.avgScore ?? "0")),
        checkCount: r.checkCount,
      }));
  }

  /**
   * K-anonymized org wellness pulse (last 7 days).
   * Never returns individual scores; suppresses when respondents < threshold.
   */
  async wellnessPulse(orgId: string) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const [agg] = await this.db
      .select({
        respondents: count(hrWellnessCheckins.userId),
        avgScore: avg(hrWellnessCheckins.score),
        checkins: count(hrWellnessCheckins.id),
      })
      .from(hrWellnessCheckins)
      .where(
        and(
          eq(hrWellnessCheckins.orgId, orgId),
          gte(hrWellnessCheckins.date, cutoffStr),
        ),
      );

    const respondents = Number(agg?.respondents ?? 0);
    const suppressed = respondents < WELLNESS_MIN_GROUP_SIZE;

    return {
      mode: "k_anonymized_pulse" as const,
      honestyNote: `Wellness pulse is k-anonymized (minimum ${WELLNESS_MIN_GROUP_SIZE} respondents). Individual scores are never shown. Not a clinical assessment.`,
      windowDays: 7,
      minGroupSize: WELLNESS_MIN_GROUP_SIZE,
      suppressed,
      respondents: suppressed ? null : respondents,
      avgScore:
        suppressed || agg?.avgScore == null
          ? null
          : Math.round(parseFloat(String(agg.avgScore)) * 10) / 10,
      checkins: suppressed ? null : Number(agg?.checkins ?? 0),
      burnoutThreshold: BURNOUT_SCORE_THRESHOLD,
    };
  }
}
