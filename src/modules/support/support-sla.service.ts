import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import {
  supportBusinessHours,
  supportSlaPolicies,
  supportTickets,
  type WeeklySchedule,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { addWorkingMinutes, type BusinessHoursConfig } from "./support-business-hours.util";
import { SupportNotificationsService } from "./support-notifications.service";
import type {
  CreateBusinessHoursInput,
  CreateSlaPolicyInput,
  TicketPriority,
  TicketStatus,
  UpdateBusinessHoursInput,
  UpdateSlaPolicyInput,
} from "./dto/support.schemas";

const DEFAULT_RESOLUTION_MINS: Record<TicketPriority, number> = {
  LOW: 48 * 60,
  MEDIUM: 24 * 60,
  HIGH: 8 * 60,
  URGENT: 2 * 60,
};

export interface ResolvedSlaPolicy {
  firstResponseTargetMins: number;
  resolutionTargetMins: number;
  pauseStatuses: string[];
  businessHours: BusinessHoursConfig | null;
}

export type SlaRiskLevel =
  | "ok"
  | "first_response_due_soon"
  | "first_response_breached"
  | "resolution_due_soon"
  | "resolution_breached"
  | "paused";

@Injectable()
export class SupportSlaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: SupportNotificationsService,
  ) {}

  listBusinessHours(orgId: string) {
    return this.db.query.supportBusinessHours.findMany({
      where: eq(supportBusinessHours.orgId, orgId),
    });
  }

  async createBusinessHours(orgId: string, input: CreateBusinessHoursInput) {
    const [row] = await this.db
      .insert(supportBusinessHours)
      .values({
        orgId,
        name: input.name,
        timezone: input.timezone,
        weeklySchedule: input.weeklySchedule as WeeklySchedule,
        holidays: input.holidays,
        is24x7: input.is24x7,
        isDefault: input.isDefault,
      })
      .returning();
    return row;
  }

  async updateBusinessHours(orgId: string, id: number, input: UpdateBusinessHoursInput) {
    const [updated] = await this.db
      .update(supportBusinessHours)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supportBusinessHours.id, id), eq(supportBusinessHours.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Business hours calendar not found");
    return updated;
  }

  async deleteBusinessHours(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(supportBusinessHours)
      .where(and(eq(supportBusinessHours.id, id), eq(supportBusinessHours.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Business hours calendar not found");
    return { success: true };
  }

  listSlaPolicies(orgId: string) {
    return this.db.query.supportSlaPolicies.findMany({
      where: eq(supportSlaPolicies.orgId, orgId),
    });
  }

  async createSlaPolicy(orgId: string, input: CreateSlaPolicyInput) {
    const [row] = await this.db
      .insert(supportSlaPolicies)
      .values({
        orgId,
        name: input.name,
        priority: input.priority ?? null,
        category: input.category ?? null,
        businessHoursId: input.businessHoursId ?? null,
        firstResponseTargetMins: input.firstResponseTargetMins,
        resolutionTargetMins: input.resolutionTargetMins,
        pauseStatuses: input.pauseStatuses,
        isEnabled: input.isEnabled,
        sortOrder: input.sortOrder,
      })
      .returning();
    return row;
  }

  async updateSlaPolicy(orgId: string, id: number, input: UpdateSlaPolicyInput) {
    const [updated] = await this.db
      .update(supportSlaPolicies)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supportSlaPolicies.id, id), eq(supportSlaPolicies.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("SLA policy not found");
    return updated;
  }

  async deleteSlaPolicy(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(supportSlaPolicies)
      .where(and(eq(supportSlaPolicies.id, id), eq(supportSlaPolicies.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("SLA policy not found");
    return { success: true };
  }

  /** Most-specific-match-wins: priority+category > priority-only > category-only > catch-all. */
  async resolvePolicy(
    orgId: string,
    priority: TicketPriority,
    category: string | null,
  ): Promise<ResolvedSlaPolicy> {
    const candidates = await this.db.query.supportSlaPolicies.findMany({
      where: and(
        eq(supportSlaPolicies.orgId, orgId),
        eq(supportSlaPolicies.isEnabled, true),
        or(isNull(supportSlaPolicies.priority), eq(supportSlaPolicies.priority, priority)),
        category
          ? or(isNull(supportSlaPolicies.category), eq(supportSlaPolicies.category, category))
          : isNull(supportSlaPolicies.category),
      ),
    });

    const scored = candidates
      .map((policy) => {
        let score = 0;
        if (policy.priority) score += 2;
        if (policy.category) score += 1;
        return { policy, score };
      })
      .sort((a, b) => b.score - a.score || a.policy.sortOrder - b.policy.sortOrder);

    const best = scored[0]?.policy;
    if (!best) {
      return {
        firstResponseTargetMins: Math.round(DEFAULT_RESOLUTION_MINS[priority] * 0.25),
        resolutionTargetMins: DEFAULT_RESOLUTION_MINS[priority],
        pauseStatuses: ["WAITING"],
        businessHours: null,
      };
    }

    let businessHours: BusinessHoursConfig | null = null;
    if (best.businessHoursId) {
      const bh = await this.db.query.supportBusinessHours.findFirst({
        where: and(eq(supportBusinessHours.id, best.businessHoursId), eq(supportBusinessHours.orgId, orgId)),
      });
      if (bh) {
        businessHours = {
          timezone: bh.timezone,
          weeklySchedule: bh.weeklySchedule,
          holidays: bh.holidays,
          is24x7: bh.is24x7,
        };
      }
    }

    return {
      firstResponseTargetMins: best.firstResponseTargetMins,
      resolutionTargetMins: best.resolutionTargetMins,
      pauseStatuses: best.pauseStatuses,
      businessHours,
    };
  }

  computeDueDates(policy: ResolvedSlaPolicy, from: Date): { firstResponseDueAt: Date; resolutionDueAt: Date } {
    return {
      firstResponseDueAt: addWorkingMinutes(from, policy.firstResponseTargetMins, policy.businessHours),
      resolutionDueAt: addWorkingMinutes(from, policy.resolutionTargetMins, policy.businessHours),
    };
  }

  /**
   * Pure risk computation off already-materialized ticket fields — no DB/policy
   * lookups here, so this stays cheap on every ticket read and easy to unit test.
   */
  computeRisk(ticket: {
    status: TicketStatus;
    createdAt: Date;
    firstRespondedAt: Date | null;
    firstResponseDueAt: Date | null;
    slaDeadline: Date | null;
    slaPausedAt: Date | null;
  }): SlaRiskLevel {
    if (["RESOLVED", "CLOSED"].includes(ticket.status)) return "ok";
    if (ticket.slaPausedAt) return "paused";

    const now = new Date();

    if (!ticket.firstRespondedAt && ticket.firstResponseDueAt) {
      const totalMs = ticket.firstResponseDueAt.getTime() - ticket.createdAt.getTime();
      const remainingMs = ticket.firstResponseDueAt.getTime() - now.getTime();
      if (remainingMs < 0) return "first_response_breached";
      if (totalMs > 0 && remainingMs < totalMs * 0.25) return "first_response_due_soon";
    }

    if (ticket.slaDeadline) {
      const totalMs = ticket.slaDeadline.getTime() - ticket.createdAt.getTime();
      const remainingMs = ticket.slaDeadline.getTime() - now.getTime();
      if (remainingMs < 0) return "resolution_breached";
      if (totalMs > 0 && remainingMs < totalMs * 0.25) return "resolution_due_soon";
    }

    return "ok";
  }

  /** Called on ticket create/update to apply pause/resume semantics for a status transition. */
  computePauseTransition(
    previousStatus: TicketStatus,
    newStatus: TicketStatus,
    pauseStatuses: string[],
    slaPausedAt: Date | null,
    slaPausedMinutes: number,
  ): { slaPausedAt: Date | null; slaPausedMinutes: number; extendByMinutes: number } {
    const wasPaused = pauseStatuses.includes(previousStatus);
    const isPaused = pauseStatuses.includes(newStatus);

    if (!wasPaused && isPaused) {
      return { slaPausedAt: new Date(), slaPausedMinutes, extendByMinutes: 0 };
    }

    if (wasPaused && !isPaused && slaPausedAt) {
      const elapsedMinutes = Math.round((Date.now() - slaPausedAt.getTime()) / 60_000);
      return {
        slaPausedAt: null,
        slaPausedMinutes: slaPausedMinutes + elapsedMinutes,
        extendByMinutes: elapsedMinutes,
      };
    }

    return { slaPausedAt, slaPausedMinutes, extendByMinutes: 0 };
  }

  async getTicketRisk(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: {
        status: true,
        createdAt: true,
        firstRespondedAt: true,
        firstResponseDueAt: true,
        slaDeadline: true,
        slaPausedAt: true,
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return { risk: this.computeRisk(ticket) };
  }

  /**
   * Scans an org's open tickets and notifies the assignee whenever a ticket
   * crosses a new SLA risk threshold since the last check (tracked via
   * slaEscalationLevel, so the same threshold never re-notifies).
   *
   * There is no cron/scheduler infrastructure in this backend yet — this is a
   * manually-triggerable endpoint (POST /support/sla/run-escalations). Wiring
   * it to run periodically (e.g. via @nestjs/schedule) is a follow-up, not
   * done here since it would be a new architectural pattern for this repo.
   *
   * Only notifies the current assignee — there's no manager/team-lead
   * hierarchy modeled in this codebase yet, so the PRD's tiered
   * assignee->team-lead->manager escalation path is simplified to
   * "notify whoever is assigned, with increasing urgency" until that
   * hierarchy exists.
   */
  async runEscalations(orgId: string): Promise<{ checked: number; escalated: number }> {
    const tickets = await this.db.query.supportTickets.findMany({
      where: and(orgId ? eq(supportTickets.orgId, orgId) : undefined, notInArray(supportTickets.status, ["RESOLVED", "CLOSED"])),
      columns: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        assigneeId: true,
        firstRespondedAt: true,
        firstResponseDueAt: true,
        slaDeadline: true,
        slaPausedAt: true,
        slaEscalationLevel: true,
      },
    });

    let escalated = 0;

    for (const ticket of tickets) {
      const risk = this.computeRisk(ticket);
      const newLevel = riskToEscalationLevel(risk);

      if (newLevel <= ticket.slaEscalationLevel) continue;

      await this.db
        .update(supportTickets)
        .set({ slaEscalationLevel: newLevel })
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.orgId, orgId)));

      if (ticket.assigneeId && (risk === "first_response_due_soon" || risk === "first_response_breached" || risk === "resolution_due_soon" || risk === "resolution_breached")) {
        try {
          await this.notifications.sendEscalationEmail(ticket.assigneeId, ticket.title, ticket.id, risk);
        } catch (error) {
          logger.error("Failed to send SLA escalation email", {
            orgId,
            ticketId: ticket.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      escalated++;
    }

    return { checked: tickets.length, escalated };
  }
}

function riskToEscalationLevel(risk: SlaRiskLevel): number {
  if (risk === "first_response_breached" || risk === "resolution_breached") return 2;
  if (risk === "first_response_due_soon" || risk === "resolution_due_soon") return 1;
  return 0;
}
