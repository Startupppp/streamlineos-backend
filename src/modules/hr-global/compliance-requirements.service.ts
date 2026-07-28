import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, gte, inArray, lte } from "drizzle-orm";
import {
  hrComplianceRequirements,
  hrComplianceEvents,
} from "../../db/schema/hr/global-compliance";
import { holidays } from "../../db/schema/hr/attendance";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { HrAuditService } from "../hr-core/hr-audit.service";
import { COUNTRY_PACKS } from "./country-packs";
import type {
  CreateComplianceRequirementInput,
  UpdateComplianceRequirementInput,
  ListComplianceRequirementInput,
  ListComplianceEventsInput,
  MarkEventDoneInput,
  SeedCountryPackInput,
} from "./dto/hr-global.schemas";

@Injectable()
export class ComplianceRequirementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async listRequirements(orgId: string, input: ListComplianceRequirementInput) {
    const { page, limit, countryCode, category, active } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrComplianceRequirements.orgId, orgId)];
    if (countryCode) conditions.push(eq(hrComplianceRequirements.countryCode, countryCode));
    if (category) conditions.push(eq(hrComplianceRequirements.category, category));
    if (active !== undefined) conditions.push(eq(hrComplianceRequirements.active, active));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrComplianceRequirements)
        .where(where)
        .orderBy(asc(hrComplianceRequirements.name))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrComplianceRequirements).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getRequirement(orgId: string, id: number) {
    const row = await this.db.query.hrComplianceRequirements.findFirst({
      where: and(eq(hrComplianceRequirements.id, id), eq(hrComplianceRequirements.orgId, orgId)),
    });
    if (!row) throw new NotFoundException("Compliance requirement not found");
    return row;
  }

  async createRequirement(orgId: string, actorId: string, input: CreateComplianceRequirementInput) {
    const [existing] = await this.db
      .select({ id: hrComplianceRequirements.id })
      .from(hrComplianceRequirements)
      .where(and(eq(hrComplianceRequirements.orgId, orgId), eq(hrComplianceRequirements.name, input.name)))
      .limit(1);
    if (existing) throw new ConflictException("A compliance requirement with this name already exists");

    const [created] = await this.db
      .insert(hrComplianceRequirements)
      .values({
        orgId,
        name: input.name,
        countryCode: input.countryCode ?? null,
        stateCode: input.stateCode ?? null,
        category: input.category,
        frequency: input.frequency,
        dueRule: input.dueRule,
        reminderDaysBefore: input.reminderDaysBefore,
        active: input.active,
        createdBy: actorId,
      })
      .returning()
      .catch((e: { code?: string }) => {
        if (e.code === "23505")
          throw new ConflictException("A compliance requirement with this name already exists.");
        throw e;
      });

    await this.audit.log({ orgId, actorId, entityType: "hr_compliance_requirements", entityId: String(created.id), action: "created", after: created });
    return created;
  }

  async updateRequirement(orgId: string, id: number, actorId: string, input: UpdateComplianceRequirementInput) {
    const existing = await this.getRequirement(orgId, id);

    if (input.name && input.name !== existing.name) {
      const [dup] = await this.db
        .select({ id: hrComplianceRequirements.id })
        .from(hrComplianceRequirements)
        .where(and(eq(hrComplianceRequirements.orgId, orgId), eq(hrComplianceRequirements.name, input.name)))
        .limit(1);
      if (dup && dup.id !== id) throw new ConflictException("Name already in use");
    }

    const [updated] = await this.db
      .update(hrComplianceRequirements)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.countryCode !== undefined && { countryCode: input.countryCode }),
        ...(input.stateCode !== undefined && { stateCode: input.stateCode }),
        ...(input.category !== undefined && { category: input.category }),
        ...(input.frequency !== undefined && { frequency: input.frequency }),
        ...(input.dueRule !== undefined && { dueRule: input.dueRule }),
        ...(input.reminderDaysBefore !== undefined && { reminderDaysBefore: input.reminderDaysBefore }),
        ...(input.active !== undefined && { active: input.active }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrComplianceRequirements.id, id), eq(hrComplianceRequirements.orgId, orgId)))
      .returning()
      .catch((e: { code?: string }) => {
        if (e.code === "23505")
          throw new ConflictException("A compliance requirement with this name already exists.");
        throw e;
      });

    await this.audit.log({ orgId, actorId, entityType: "hr_compliance_requirements", entityId: String(id), action: "updated", before: existing, after: updated });
    return updated;
  }

  async deleteRequirement(orgId: string, id: number, actorId: string) {
    await this.getRequirement(orgId, id);
    await this.db.delete(hrComplianceRequirements).where(and(eq(hrComplianceRequirements.id, id), eq(hrComplianceRequirements.orgId, orgId)));
    await this.audit.log({ orgId, actorId, entityType: "hr_compliance_requirements", entityId: String(id), action: "deleted" });
    return { ok: true };
  }

  async listEvents(orgId: string, input: ListComplianceEventsInput) {
    const { page, limit, requirementId, status, from, to } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrComplianceEvents.orgId, orgId)];
    if (requirementId) conditions.push(eq(hrComplianceEvents.requirementId, requirementId));
    if (status) conditions.push(eq(hrComplianceEvents.status, status));
    if (from) conditions.push(gte(hrComplianceEvents.dueDate, from));
    if (to) conditions.push(lte(hrComplianceEvents.dueDate, to));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select({
          event: hrComplianceEvents,
          requirementName: hrComplianceRequirements.name,
          category: hrComplianceRequirements.category,
          reminderDaysBefore: hrComplianceRequirements.reminderDaysBefore,
        })
        .from(hrComplianceEvents)
        .leftJoin(hrComplianceRequirements, eq(hrComplianceEvents.requirementId, hrComplianceRequirements.id))
        .where(where)
        .orderBy(asc(hrComplianceEvents.dueDate))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrComplianceEvents).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;
    return {
      data: data.map((r) => ({ ...r.event, requirementName: r.requirementName, category: r.category, reminderDaysBefore: r.reminderDaysBefore })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async markEventDone(orgId: string, eventId: number, actorId: string, input: MarkEventDoneInput) {
    const [event] = await this.db
      .select()
      .from(hrComplianceEvents)
      .where(and(eq(hrComplianceEvents.id, eventId), eq(hrComplianceEvents.orgId, orgId)))
      .limit(1);
    if (!event) throw new NotFoundException("Compliance event not found");

    const [updated] = await this.db
      .update(hrComplianceEvents)
      .set({
        status: "done",
        completedBy: actorId,
        completedAt: new Date(),
        notes: input.notes ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(hrComplianceEvents.id, eventId), eq(hrComplianceEvents.orgId, orgId)))
      .returning();

    await this.audit.log({ orgId, actorId, entityType: "hr_compliance_events", entityId: String(eventId), action: "marked_done" });
    return updated;
  }

  async generateEvents(orgId: string, requirementId?: number) {
    const conditions = [eq(hrComplianceRequirements.orgId, orgId), eq(hrComplianceRequirements.active, true)];
    if (requirementId) conditions.push(eq(hrComplianceRequirements.id, requirementId));

    const reqs = await this.db.select().from(hrComplianceRequirements).where(and(...conditions));
    const now = new Date();
    const horizon = new Date(now);
    horizon.setMonth(horizon.getMonth() + 12);

    const dueDates: Array<{ requirementId: number; dueDate: string }> = [];

    for (const req of reqs) {
      const dates = this.computeDueDates(req.frequency, req.dueRule as { month?: number; day?: number; offsetDays?: number }, now, horizon);
      for (const d of dates) {
        dueDates.push({ requirementId: req.id, dueDate: d });
      }
    }

    if (dueDates.length === 0) return { generated: 0, total: 0 };

    const reqIds = [...new Set(dueDates.map((d) => d.requirementId))];
    const existingEvents = await this.db
      .select({ requirementId: hrComplianceEvents.requirementId, dueDate: hrComplianceEvents.dueDate })
      .from(hrComplianceEvents)
      .where(
        and(
          eq(hrComplianceEvents.orgId, orgId),
          inArray(hrComplianceEvents.requirementId, reqIds),
        ),
      );

    const existingKeys = new Set(
      existingEvents.map((e) => `${e.requirementId}:${e.dueDate}`),
    );

    const toInsert = dueDates.filter(
      (dd) => !existingKeys.has(`${dd.requirementId}:${dd.dueDate}`),
    );

    if (toInsert.length > 0) {
      await this.db.insert(hrComplianceEvents).values(
        toInsert.map((dd) => ({ orgId, requirementId: dd.requirementId, dueDate: dd.dueDate, status: "pending" as const })),
      );
    }

    return { generated: toInsert.length, total: dueDates.length };
  }

  async markOverdueEvents(orgId: string) {
    const today = new Date().toISOString().split("T")[0];
    await this.db
      .update(hrComplianceEvents)
      .set({ status: "overdue", updatedAt: new Date() })
      .where(and(eq(hrComplianceEvents.orgId, orgId), eq(hrComplianceEvents.status, "pending"), lte(hrComplianceEvents.dueDate, today)));
  }

  private computeDueDates(
    frequency: string,
    dueRule: { month?: number; day?: number; offsetDays?: number },
    from: Date,
    until: Date,
  ): string[] {
    const dates: string[] = [];
    const { month, day, offsetDays } = dueRule;

    if (frequency === "once") {
      if (month && day) {
        const d = new Date(from.getFullYear(), month - 1, day);
        if (d >= from && d <= until) dates.push(d.toISOString().split("T")[0]);
      }
      return dates;
    }

    if (frequency === "monthly") {
      const anchorDay = day ?? 15;
      const cur = new Date(from.getFullYear(), from.getMonth(), anchorDay);
      while (cur <= until) {
        if (cur >= from) dates.push(cur.toISOString().split("T")[0]);
        cur.setMonth(cur.getMonth() + 1);
      }
    } else if (frequency === "quarterly") {
      const quarterMonths = [3, 6, 9, 12];
      const anchorDay = offsetDays ?? 30;
      for (const m of quarterMonths) {
        for (let yr = from.getFullYear(); yr <= until.getFullYear(); yr++) {
          const d = new Date(yr, m - 1 + 1, 0);
          d.setDate(d.getDate() + anchorDay);
          if (d >= from && d <= until) dates.push(d.toISOString().split("T")[0]);
        }
      }
    } else if (frequency === "yearly") {
      const anchorMonth = month ? month - 1 : 11;
      const anchorDay = day ?? 31;
      for (let yr = from.getFullYear(); yr <= until.getFullYear(); yr++) {
        const d = new Date(yr, anchorMonth, anchorDay);
        if (d >= from && d <= until) dates.push(d.toISOString().split("T")[0]);
      }
    }

    return dates;
  }

  async seedCountryPack(orgId: string, actorId: string, input: SeedCountryPackInput) {
    const pack = COUNTRY_PACKS[input.country.toUpperCase()] ?? COUNTRY_PACKS["GENERIC"];
    if (!pack) return { holidays: 0, requirements: 0 };

    const year = input.year ?? new Date().getFullYear();

    const holidayDates = pack.defaultHolidays.map((h) => `${year}-${h.date}`);
    const reqNames = pack.complianceRequirements.map((r) => r.name);

    const [existingHolidays, existingReqs] = await Promise.all([
      holidayDates.length > 0
        ? this.db
            .select({ date: holidays.date })
            .from(holidays)
            .where(and(eq(holidays.orgId, orgId), inArray(holidays.date, holidayDates)))
        : Promise.resolve([]),
      reqNames.length > 0
        ? this.db
            .select({ name: hrComplianceRequirements.name })
            .from(hrComplianceRequirements)
            .where(and(eq(hrComplianceRequirements.orgId, orgId), inArray(hrComplianceRequirements.name, reqNames)))
        : Promise.resolve([]),
    ]);

    const existingHolidayDates = new Set(existingHolidays.map((h) => h.date));
    const existingReqNames = new Set(existingReqs.map((r) => r.name));

    const holidaysToInsert = pack.defaultHolidays
      .map((h) => ({ fullDate: `${year}-${h.date}`, h }))
      .filter(({ fullDate }) => !existingHolidayDates.has(fullDate));

    const reqsToInsert = pack.complianceRequirements.filter((r) => !existingReqNames.has(r.name));

    const [holidaysResult, reqsResult] = await Promise.all([
      holidaysToInsert.length > 0
        ? this.db
            .insert(holidays)
            .values(holidaysToInsert.map(({ fullDate, h }) => ({ orgId, name: h.name, date: fullDate, isPublic: h.isPublic })))
            .returning({ id: holidays.id })
        : Promise.resolve([]),
      reqsToInsert.length > 0
        ? this.db
            .insert(hrComplianceRequirements)
            .values(
              reqsToInsert.map((r) => ({
                orgId,
                name: r.name,
                countryCode: pack.countryCode,
                category: r.category,
                frequency: r.frequency,
                dueRule: r.dueRule,
                reminderDaysBefore: r.reminderDaysBefore,
                active: true,
                createdBy: actorId,
              })),
            )
            .returning({ id: hrComplianceRequirements.id })
        : Promise.resolve([]),
    ]);

    return {
      country: pack.countryCode,
      holidays: holidaysResult.length,
      requirements: reqsResult.length,
      sensitiveFieldKeys: pack.sensitiveFieldKeys,
    };
  }
}
