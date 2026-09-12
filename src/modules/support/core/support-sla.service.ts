import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  supportBusinessHours,
  supportSlaPolicies,
  supportTickets,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { addWorkingMinutes, type BusinessHoursConfig } from "./support-business-hours.util";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportMacrosService } from "./support-macros.service";
import {
  computeRisk,
  runEscalations,
  runEscalationsForAllOrgs,
  type SlaEscalationDeps,
  type SlaRiskLevel,
} from "./lib/support-sla-escalation";

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

export type { SlaRiskLevel } from "./lib/support-sla-escalation";

@Injectable()
export class SupportSlaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: SupportNotificationsService,
    private readonly macros: SupportMacrosService,
    private readonly access: AccessService,
  ) {}

  private get escalationDeps(): SlaEscalationDeps {
    return {
      db: this.db,
      notifications: this.notifications,
      macros: this.macros,
      access: this.access,
    };
  }

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

  computeRisk(ticket: {
    status: TicketStatus;
    createdAt: Date;
    firstRespondedAt: Date | null;
    firstResponseDueAt: Date | null;
    slaDeadline: Date | null;
    slaPausedAt: Date | null;
  }): SlaRiskLevel {
    return computeRisk(ticket);
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
    return { risk: computeRisk(ticket) };
  }

  runEscalations(orgId: string): Promise<{ checked: number; escalated: number }> {
    return runEscalations(this.escalationDeps, orgId);
  }

  runEscalationsForAllOrgs(): Promise<{ orgsProcessed: number; checked: number; escalated: number }> {
    return runEscalationsForAllOrgs(this.escalationDeps);
  }
}
