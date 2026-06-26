import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { npsSurveys, npsResponses, supportTickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { npsBreakdown, npsScore, type NpsCategory } from "./nps.helpers";
import type { CreateSurveyInput, UpdateSurveyInput } from "./dto/customer-executive.schemas";

const TREND_WINDOW = 50;

const SLA_TARGETS: Record<string, { firstResponse: number; resolution: number }> = {
  URGENT: { firstResponse: 2, resolution: 8 },
  HIGH: { firstResponse: 4, resolution: 24 },
  MEDIUM: { firstResponse: 8, resolution: 48 },
  LOW: { firstResponse: 24, resolution: 72 },
};

@Injectable()
export class CustomerExecutiveService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listSurveys(orgId: string) {
    const surveys = await this.db
      .select()
      .from(npsSurveys)
      .where(eq(npsSurveys.orgId, orgId))
      .orderBy(desc(npsSurveys.createdAt));

    const counts = await this.db
      .select({
        surveyId: npsResponses.surveyId,
        category: npsResponses.category,
        count: sql<number>`count(*)::int`,
      })
      .from(npsResponses)
      .where(eq(npsResponses.orgId, orgId))
      .groupBy(npsResponses.surveyId, npsResponses.category);

    const tally = new Map<number, { promoters: number; passives: number; detractors: number; total: number }>();
    for (const row of counts) {
      const entry = tally.get(row.surveyId) ?? { promoters: 0, passives: 0, detractors: 0, total: 0 };
      if (row.category === "promoter") entry.promoters += row.count;
      else if (row.category === "passive") entry.passives += row.count;
      else entry.detractors += row.count;
      entry.total += row.count;
      tally.set(row.surveyId, entry);
    }

    return surveys.map((survey) => {
      const breakdown = tally.get(survey.id) ?? { promoters: 0, passives: 0, detractors: 0, total: 0 };
      return {
        ...survey,
        responseCount: breakdown.total,
        promoters: breakdown.promoters,
        passives: breakdown.passives,
        detractors: breakdown.detractors,
        nps: npsScore(breakdown),
      };
    });
  }

  async createSurvey(orgId: string, userId: string, input: CreateSurveyInput) {
    const [survey] = await this.db
      .insert(npsSurveys)
      .values({
        orgId,
        title: input.title,
        question: input.question,
        publicToken: randomUUID(),
        createdBy: userId,
      })
      .returning();

    return {
      ...survey,
      responseCount: 0,
      promoters: 0,
      passives: 0,
      detractors: 0,
      nps: 0,
    };
  }

  async getSurveyStats(orgId: string) {
    const activeSurveys = await this.db
      .select({ id: npsSurveys.id })
      .from(npsSurveys)
      .where(and(eq(npsSurveys.orgId, orgId), eq(npsSurveys.status, "active")));

    const activeIds = new Set(activeSurveys.map((s) => s.id));

    const recent = await this.db
      .select({
        category: npsResponses.category,
        surveyId: npsResponses.surveyId,
        createdAt: npsResponses.createdAt,
      })
      .from(npsResponses)
      .where(eq(npsResponses.orgId, orgId))
      .orderBy(desc(npsResponses.createdAt))
      .limit(TREND_WINDOW);

    const activeCategories = recent
      .filter((r) => activeIds.has(r.surveyId))
      .map((r) => r.category as NpsCategory);

    const breakdown = npsBreakdown(activeCategories);

    const trend = [...recent].reverse().map((r) => ({
      category: r.category as NpsCategory,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));

    return {
      activeSurveys: activeSurveys.length,
      breakdown,
      nps: npsScore(breakdown),
      trend,
    };
  }

  async getSurvey(orgId: string, surveyId: number) {
    const survey = await this.db.query.npsSurveys.findFirst({
      where: and(eq(npsSurveys.id, surveyId), eq(npsSurveys.orgId, orgId)),
    });
    if (!survey) return null;

    const responses = await this.db
      .select()
      .from(npsResponses)
      .where(and(eq(npsResponses.surveyId, surveyId), eq(npsResponses.orgId, orgId)))
      .orderBy(desc(npsResponses.createdAt));

    const breakdown = npsBreakdown(responses.map((r) => r.category as NpsCategory));

    return {
      survey,
      responses,
      breakdown,
      nps: npsScore(breakdown),
    };
  }

  async updateSurvey(orgId: string, surveyId: number, input: UpdateSurveyInput) {
    const [updated] = await this.db
      .update(npsSurveys)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(npsSurveys.id, surveyId), eq(npsSurveys.orgId, orgId)))
      .returning();

    if (!updated) return null;
    return updated;
  }

  async deleteSurvey(orgId: string, surveyId: number) {
    const [deleted] = await this.db
      .delete(npsSurveys)
      .where(and(eq(npsSurveys.id, surveyId), eq(npsSurveys.orgId, orgId)))
      .returning();

    if (!deleted) return null;
    return { success: true };
  }

  async getSlaReport(orgId: string) {
    const tickets = await this.db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.orgId, orgId));

    const now = Date.now();

    interface TicketAnalysis {
      id: number;
      title: string;
      priority: string;
      status: string;
      createdAt: Date;
      resolvedAt: Date | null;
      closedAt: Date | null;
      slaDeadline: Date | null;
      hoursOpen: number;
      resolutionHours: number | null;
      slaTarget: number;
      breached: boolean;
    }

    const analyzed: TicketAnalysis[] = tickets.map((t) => {
      const priority = (t.priority ?? "MEDIUM").toUpperCase();
      const sla = SLA_TARGETS[priority] ?? SLA_TARGETS.MEDIUM;
      const createdMs = t.createdAt ? new Date(t.createdAt).getTime() : now;
      const hoursOpen = (now - createdMs) / 3_600_000;

      const resolvedMs = t.resolvedAt
        ? new Date(t.resolvedAt).getTime()
        : t.closedAt
          ? new Date(t.closedAt).getTime()
          : null;
      const resolutionHours = resolvedMs ? (resolvedMs - createdMs) / 3_600_000 : null;

      let breached = false;
      if (t.slaDeadline) {
        const deadlineMs = new Date(t.slaDeadline).getTime();
        if (resolutionHours !== null) {
          breached = resolvedMs! > deadlineMs;
        } else {
          breached = now > deadlineMs;
        }
      } else {
        if (resolutionHours !== null) {
          breached = resolutionHours > sla.resolution;
        } else if (t.status !== "CLOSED" && t.status !== "RESOLVED") {
          breached = hoursOpen > sla.resolution;
        }
      }

      return {
        id: t.id,
        title: t.title,
        priority,
        status: t.status,
        createdAt: t.createdAt ?? new Date(),
        resolvedAt: t.resolvedAt,
        closedAt: t.closedAt,
        slaDeadline: t.slaDeadline,
        hoursOpen: Math.round(hoursOpen * 10) / 10,
        resolutionHours: resolutionHours !== null ? Math.round(resolutionHours * 10) / 10 : null,
        slaTarget: sla.resolution,
        breached,
      };
    });

    const totalTickets = analyzed.length;
    const slaBreached = analyzed.filter((t) => t.breached).length;
    const withinSla = totalTickets - slaBreached;
    const complianceRate = totalTickets > 0 ? Math.round((withinSla / totalTickets) * 100) : 100;

    const resolvedTickets = analyzed.filter((t) => t.resolutionHours !== null);
    const avgResolutionHours =
      resolvedTickets.length > 0
        ? Math.round(
            (resolvedTickets.reduce((sum, t) => sum + (t.resolutionHours ?? 0), 0) / resolvedTickets.length) * 10,
          ) / 10
        : 0;

    const priorities = ["URGENT", "HIGH", "MEDIUM", "LOW"];
    const byPriority = priorities.map((priority) => {
      const group = analyzed.filter((t) => t.priority === priority);
      const groupResolved = group.filter((t) => t.resolutionHours !== null);
      const avgRes =
        groupResolved.length > 0
          ? Math.round(
              (groupResolved.reduce((sum, t) => sum + (t.resolutionHours ?? 0), 0) / groupResolved.length) * 10,
            ) / 10
          : 0;
      return {
        priority,
        total: group.length,
        withinSla: group.filter((t) => !t.breached).length,
        breached: group.filter((t) => t.breached).length,
        avgResolutionHours: avgRes,
        slaTarget: SLA_TARGETS[priority]?.resolution ?? 48,
      };
    });

    const recentBreaches = analyzed
      .filter((t) => t.breached)
      .sort((a, b) => b.hoursOpen - a.hoursOpen)
      .slice(0, 10)
      .map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        hoursOpen: t.hoursOpen,
        slaTarget: t.slaTarget,
      }));

    return {
      stats: {
        totalTickets,
        withinSla,
        slaBreached,
        complianceRate,
        avgResolutionHours,
      },
      byPriority,
      recentBreaches,
    };
  }
}
