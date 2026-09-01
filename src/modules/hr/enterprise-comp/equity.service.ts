import { Inject, Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { and, count, desc, eq, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrEquityGrants,
  hrEquityVestingEvents,
  hrEquityExercises,
} from "../../../db/schema/hr/enterprise-comp";
import { HrAuditService } from "../core/hr-audit.service";
import type {
  CreateEquityGrantInput,
  UpdateEquityGrantInput,
  ListEquityGrantsInput,
  CreateExerciseInput,
} from "./dto/enterprise-comp.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildVestingSchedule(grantDate: string, cliffMonths: number, vestingMonths: number, totalUnits: number) {
  const start = new Date(grantDate);
  const events: { vestDate: string; unitsVested: number; cumulativeVested: number }[] = [];

  if (vestingMonths === 0) return events;

  const unitsPerMonth = Math.floor(totalUnits / vestingMonths);
  const remainder = totalUnits - unitsPerMonth * vestingMonths;
  let cumulative = 0;

  for (let m = cliffMonths === 0 ? 1 : cliffMonths; m <= vestingMonths; m++) {
    const isFirst = m === (cliffMonths === 0 ? 1 : cliffMonths);
    const cliffUnits = cliffMonths > 0 && isFirst ? unitsPerMonth * cliffMonths : unitsPerMonth;
    const extra = m === vestingMonths ? remainder : 0;
    const vested = cliffUnits + extra;
    cumulative += vested;
    events.push({ vestDate: toDateString(addMonths(start, m)), unitsVested: vested, cumulativeVested: cumulative });

    if (cliffMonths > 0 && isFirst) {
      for (let after = cliffMonths + 1; after <= vestingMonths; after++) {
        const e = after === vestingMonths ? unitsPerMonth + remainder : unitsPerMonth;
        cumulative += e;
        events.push({ vestDate: toDateString(addMonths(start, after)), unitsVested: e, cumulativeVested: cumulative });
      }
      break;
    }
  }

  return events;
}

@Injectable()
export class EquityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async createGrant(orgId: string, actorId: string, input: CreateEquityGrantInput) {
    const [created] = await this.db.insert(hrEquityGrants).values({
      orgId,
      userId: input.userId,
      grantType: input.grantType,
      units: input.units,
      strikePriceCents: input.strikePriceCents ?? null,
      grantDate: input.grantDate,
      cliffMonths: input.cliffMonths,
      vestingMonths: input.vestingMonths,
      documentUrl: input.documentUrl ?? null,
      notes: input.notes ?? null,
      createdBy: actorId,
    }).returning();

    if (!created) throw new Error("Failed to create equity grant");

    const schedule = buildVestingSchedule(input.grantDate, input.cliffMonths, input.vestingMonths, input.units);

    if (schedule.length > 0) {
      await this.db.insert(hrEquityVestingEvents).values(
        schedule.map((e) => ({ orgId, grantId: created.id, ...e })),
      );
    }

    await this.audit.log({ orgId, actorId, entityType: "hr_equity_grants", entityId: String(created.id), action: "created", after: created });
    return { ...created, vestingSchedule: schedule };
  }

  async listGrants(orgId: string, input: ListEquityGrantsInput) {
    const { cursor, limit, userId, status, grantType } = input;
    const conditions = [eq(hrEquityGrants.orgId, orgId)];
    if (userId) conditions.push(eq(hrEquityGrants.userId, userId));
    if (status) conditions.push(eq(hrEquityGrants.status, status));
    if (grantType) conditions.push(eq(hrEquityGrants.grantType, grantType));
    const baseWhere = and(...conditions);
    const position = decodeCursor(cursor);
    const where = and(
      baseWhere,
      position ? keysetBeforeId(hrEquityGrants.createdAt, hrEquityGrants.id, position) : undefined,
    );

    const [data, totalResult] = await Promise.all([
      this.db.select().from(hrEquityGrants).where(where).orderBy(desc(hrEquityGrants.createdAt), desc(hrEquityGrants.id)).limit(limit + 1),
      this.db.select({ total: count() }).from(hrEquityGrants).where(baseWhere),
    ]);
    const total = totalResult[0]?.total ?? 0;
    const page = buildCursorPage(data, limit, (grant) => ({
      sortValue: grant.createdAt.toISOString(),
      id: String(grant.id),
    }));
    return { data: page.data, total, pagination: page.pagination };
  }

  async getGrant(orgId: string, grantId: number) {
    const [grant] = await this.db.select().from(hrEquityGrants).where(and(eq(hrEquityGrants.id, grantId), eq(hrEquityGrants.orgId, orgId))).limit(1);
    if (!grant) throw new NotFoundException("Equity grant not found");

    const vestingEvents = await this.db.select().from(hrEquityVestingEvents).where(and(eq(hrEquityVestingEvents.grantId, grantId), eq(hrEquityVestingEvents.orgId, orgId))).orderBy(hrEquityVestingEvents.vestDate);
    const exercises = await this.db.select().from(hrEquityExercises).where(and(eq(hrEquityExercises.grantId, grantId), eq(hrEquityExercises.orgId, orgId))).orderBy(hrEquityExercises.exerciseDate);

    return { ...grant, vestingEvents, exercises };
  }

  async updateGrant(orgId: string, grantId: number, actorId: string, input: UpdateEquityGrantInput) {
    const [existing] = await this.db.select().from(hrEquityGrants).where(and(eq(hrEquityGrants.id, grantId), eq(hrEquityGrants.orgId, orgId))).limit(1);
    if (!existing) throw new NotFoundException("Equity grant not found");

    const setData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.status !== undefined) setData["status"] = input.status;
    if (input.documentUrl !== undefined) setData["documentUrl"] = input.documentUrl;
    if (input.notes !== undefined) setData["notes"] = input.notes;
    if (input.boardApprovedAt !== undefined) setData["boardApprovedAt"] = new Date(input.boardApprovedAt);

    const [updated] = await this.db.update(hrEquityGrants).set(setData as never).where(and(eq(hrEquityGrants.id, grantId), eq(hrEquityGrants.orgId, orgId))).returning();
    await this.audit.log({ orgId, actorId, entityType: "hr_equity_grants", entityId: String(grantId), action: "updated", before: existing, after: updated });
    return updated;
  }

  async getVestingSchedule(orgId: string, grantId: number) {
    const [grant] = await this.db.select({ id: hrEquityGrants.id }).from(hrEquityGrants).where(and(eq(hrEquityGrants.id, grantId), eq(hrEquityGrants.orgId, orgId))).limit(1);
    if (!grant) throw new NotFoundException("Equity grant not found");

    return this.db.select().from(hrEquityVestingEvents).where(and(eq(hrEquityVestingEvents.grantId, grantId), eq(hrEquityVestingEvents.orgId, orgId))).orderBy(hrEquityVestingEvents.vestDate);
  }

  async recordExercise(orgId: string, actorId: string, input: CreateExerciseInput) {
    const [grant] = await this.db.select().from(hrEquityGrants).where(and(eq(hrEquityGrants.id, input.grantId), eq(hrEquityGrants.orgId, orgId))).limit(1);
    if (!grant) throw new NotFoundException("Equity grant not found");
    if (grant.status !== "active") throw new BadRequestException("Grant is not active");

    const [[vestedRow], [exercisedRow]] = await Promise.all([
      this.db
        .select({ total: sql<number>`COALESCE(SUM(units_vested), 0)` })
        .from(hrEquityVestingEvents)
        .where(and(eq(hrEquityVestingEvents.grantId, input.grantId), eq(hrEquityVestingEvents.orgId, orgId), lte(hrEquityVestingEvents.vestDate, input.exerciseDate))),
      this.db
        .select({ total: sql<number>`COALESCE(SUM(units), 0)` })
        .from(hrEquityExercises)
        .where(and(eq(hrEquityExercises.grantId, input.grantId), eq(hrEquityExercises.orgId, orgId))),
    ]);

    const totalVested = Number(vestedRow?.total ?? 0);
    const exercised = Number(exercisedRow?.total ?? 0);

    if (input.units > totalVested - exercised) {
      throw new BadRequestException(`Only ${totalVested - exercised} vested units available`);
    }

    const [created] = await this.db.insert(hrEquityExercises).values({ orgId, ...input, createdBy: actorId }).returning();
    await this.audit.log({ orgId, actorId, entityType: "hr_equity_exercises", entityId: String(created!.id), action: "created", after: created });
    return created;
  }

  async getExitTreatment(orgId: string, grantId: number, exitDate: string) {
    const [grant] = await this.db.select().from(hrEquityGrants).where(and(eq(hrEquityGrants.id, grantId), eq(hrEquityGrants.orgId, orgId))).limit(1);
    if (!grant) throw new NotFoundException("Equity grant not found");

    const [[vestedRow], [exercisedRow]] = await Promise.all([
      this.db
        .select({ total: sql<number>`COALESCE(SUM(units_vested), 0)` })
        .from(hrEquityVestingEvents)
        .where(and(eq(hrEquityVestingEvents.grantId, grantId), eq(hrEquityVestingEvents.orgId, orgId), lte(hrEquityVestingEvents.vestDate, exitDate))),
      this.db
        .select({ total: sql<number>`COALESCE(SUM(units), 0)` })
        .from(hrEquityExercises)
        .where(and(eq(hrEquityExercises.grantId, grantId), eq(hrEquityExercises.orgId, orgId))),
    ]);

    const vestedUnits = Number(vestedRow?.total ?? 0);
    const exercisedUnits = Number(exercisedRow?.total ?? 0);
    const unvestedUnits = grant.units - vestedUnits;
    const exercisableUnits = vestedUnits - exercisedUnits;

    return {
      grantId,
      grantType: grant.grantType,
      totalUnits: grant.units,
      vestedUnits,
      unvestedUnits,
      exercisedUnits,
      exercisableUnits,
      strikePriceCents: grant.strikePriceCents,
      unvestedTreatment: "forfeited",
      vestedTreatment: exercisableUnits > 0 ? "exercisable" : "fully_exercised",
    };
  }
}
