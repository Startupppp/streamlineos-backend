import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import {
  supportBusinessHours,
  supportSlaPolicies,
  supportTickets,
  organizationMembers,
  type WeeklySchedule,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { addWorkingMinutes, type BusinessHoursConfig } from "./support-business-hours.util";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportMacrosService } from "./support-macros.service";

const MANAGER_ROLES = ["OWNER", "CEO", "ADMIN"];
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
    private readonly macros: SupportMacrosService,
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
        weeklySchedule: input.weeklySchedule,
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
   * slaEscalationLevel, so the same threshold never re-notifies). Tickets
   * still breached on a SUBSEQUENT sweep (already at the max level and still
   * breached) escalate to org owners/admins ("manager tier") and trigger a
   * one-time auto-reassignment attempt via the same routing rules used at
   * ticket creation — this only re-fires the manager notification if the
   * ticket keeps getting reassigned and re-breaching, since escalationLevel
   * itself doesn't distinguish "just breached" from "breached again."
   *
   * Scheduling: wired into the standard cron pattern via
   * POST/GET /cron/support-sla-escalations (src/modules/cron) — an external
   * scheduler still needs to actually call it periodically, same as every
   * other job in that module; nothing in this repo self-schedules.
   */
  async runEscalations(orgId: string): Promise<{ checked: number; escalated: number }> {
    const tickets = await this.db.query.supportTickets.findMany({
      where: and(orgId ? eq(supportTickets.orgId, orgId) : undefined, notInArray(supportTickets.status, ["RESOLVED", "CLOSED"])),
      columns: {
        id: true,
        title: true,
        status: true,
        category: true,
        priority: true,
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
      const isBreach = risk === "first_response_breached" || risk === "resolution_breached";
      const isRepeatBreach = isBreach && ticket.slaEscalationLevel >= newLevel;

      if (newLevel <= ticket.slaEscalationLevel && !isRepeatBreach) continue;

      if (newLevel > ticket.slaEscalationLevel) {
        await this.db
          .update(supportTickets)
          .set({ slaEscalationLevel: newLevel })
          .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.orgId, orgId)));
      }

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

      if (isRepeatBreach) {
        const reassignedTo = await this.tryAutoReassign(orgId, ticket);
        await this.notifyManagers(orgId, ticket, risk, reassignedTo);
      }

      escalated++;
    }

    return { checked: tickets.length, escalated };
  }

  /** Cron entrypoint — sweeps every org with at least one open ticket, not just the caller's own. */
  async runEscalationsForAllOrgs(): Promise<{ orgsProcessed: number; checked: number; escalated: number }> {
    const orgs = await this.db
      .selectDistinct({ orgId: supportTickets.orgId })
      .from(supportTickets)
      .where(notInArray(supportTickets.status, ["RESOLVED", "CLOSED"]));

    let checked = 0;
    let escalated = 0;
    for (const { orgId } of orgs) {
      const result = await this.runEscalations(orgId);
      checked += result.checked;
      escalated += result.escalated;
    }
    return { orgsProcessed: orgs.length, checked, escalated };
  }

  /**
   * One-time reassignment attempt for a ticket that's breached and stayed
   * breached across sweeps — re-runs the same routing rules used at ticket
   * creation (round-robin/load-balanced candidates rotate the same way) and
   * only reassigns if that resolves to someone OTHER than the current
   * assignee, so a ticket with no matching rule or a single-candidate rule
   * doesn't get bounced back to the same person repeatedly.
   */
  private async tryAutoReassign(
    orgId: string,
    ticket: { id: number; title: string; category: string | null; priority: string; assigneeId: string | null },
  ): Promise<string | null> {
    try {
      const routing = await this.macros.applyRoutingRules(orgId, {
        title: ticket.title,
        category: ticket.category,
        priority: ticket.priority,
      });
      if (!routing.assigneeId || routing.assigneeId === ticket.assigneeId) return null;

      await this.db
        .update(supportTickets)
        .set({ assigneeId: routing.assigneeId, updatedAt: new Date() })
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.orgId, orgId)));
      return routing.assigneeId;
    } catch (error) {
      logger.error("SLA auto-reassignment failed", {
        orgId,
        ticketId: ticket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async notifyManagers(
    orgId: string,
    ticket: { id: number; title: string },
    risk: SlaRiskLevel,
    reassignedTo: string | null,
  ): Promise<void> {
    if (risk !== "first_response_breached" && risk !== "resolution_breached") return;

    const managers = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.role, MANAGER_ROLES)));

    for (const manager of managers) {
      if (manager.userId === reassignedTo) continue;
      try {
        await this.notifications.sendEscalationEmail(manager.userId, ticket.title, ticket.id, risk);
      } catch (error) {
        logger.error("Failed to send SLA manager-tier escalation email", {
          orgId,
          ticketId: ticket.id,
          managerId: manager.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function riskToEscalationLevel(risk: SlaRiskLevel): number {
  if (risk === "first_response_breached" || risk === "resolution_breached") return 2;
  if (risk === "first_response_due_soon" || risk === "resolution_due_soon") return 1;
  return 0;
}
