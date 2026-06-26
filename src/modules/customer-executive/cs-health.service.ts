import { Inject, Injectable } from "@nestjs/common";
import { eq, max } from "drizzle-orm";
import {
  clientAccounts,
  clientAccountActivities,
  csatResponses,
  supportTickets,
  healthScoreConfig,
  clientHealthScores,
  type HealthScoreWeights,
  type HealthScoreThresholds,
  type HealthScoreBreakdown,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NEUTRAL_BASELINE = 50;

const SLA_RESOLUTION_TARGETS: Record<string, number> = {
  URGENT: 8,
  HIGH: 24,
  MEDIUM: 48,
  LOW: 72,
};

export type HealthStatus = "healthy" | "at_risk" | "critical";

export interface HealthScoreResult {
  clientAccountId: number;
  clientName: string;
  score: number;
  status: HealthStatus;
  breakdown: HealthScoreBreakdown;
}

export function getDefaultHealthConfig(): {
  weights: HealthScoreWeights;
  thresholds: HealthScoreThresholds;
} {
  return {
    weights: { sla: 25, csat: 25, activity: 20, renewal: 15, tickets: 15 },
    thresholds: { healthy: 70, atRisk: 40 },
  };
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return NEUTRAL_BASELINE;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function mapStatus(score: number, thresholds: HealthScoreThresholds): HealthStatus {
  if (score >= thresholds.healthy) return "healthy";
  if (score >= thresholds.atRisk) return "at_risk";
  return "critical";
}

function computeSlaScore(tickets: { resolved: boolean; resolutionHours: number | null; hoursOpen: number; target: number }[]): number {
  if (tickets.length === 0) return NEUTRAL_BASELINE;
  let withinSla = 0;
  for (const t of tickets) {
    const elapsed = t.resolutionHours ?? t.hoursOpen;
    if (elapsed <= t.target) withinSla += 1;
  }
  return clamp((withinSla / tickets.length) * 100);
}

function computeCsatScore(latest: number | null, avg: number | null, scaleMax: number): number {
  if (latest === null && avg === null) return NEUTRAL_BASELINE;
  const safeLatest = latest ?? avg ?? 0;
  const safeAvg = avg ?? latest ?? 0;
  const blended = safeLatest * 0.6 + safeAvg * 0.4;
  return clamp((blended / scaleMax) * 100);
}

function computeActivityScore(daysSinceLast: number | null): number {
  if (daysSinceLast === null) return NEUTRAL_BASELINE;
  if (daysSinceLast <= 7) return 100;
  if (daysSinceLast >= 90) return 0;
  return clamp(100 - ((daysSinceLast - 7) / 83) * 100);
}

function computeRenewalScore(daysToRenewal: number | null): number {
  if (daysToRenewal === null) return NEUTRAL_BASELINE;
  if (daysToRenewal < 0) return 0;
  if (daysToRenewal >= 90) return 100;
  return clamp((daysToRenewal / 90) * 100);
}

function computeTicketsScore(openTickets: number, overdueTickets: number): number {
  const penalty = openTickets * 8 + overdueTickets * 20;
  return clamp(100 - penalty);
}

export interface LatestHealthScore {
  clientAccountId: number;
  clientName: string;
  score: number;
  status: HealthStatus;
  breakdown: HealthScoreBreakdown;
  computedAt: string;
}

export interface HealthScoresSummary {
  healthy: number;
  atRisk: number;
  critical: number;
  total: number;
  avgScore: number;
}

@Injectable()
export class CsHealthService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async computeHealthForOrg(orgId: string): Promise<HealthScoreResult[]> {
    const [configRow, accounts, activityAggs, csatAggs, ticketRows] = await Promise.all([
      this.db.query.healthScoreConfig.findFirst({ where: eq(healthScoreConfig.orgId, orgId) }),
      this.db
        .select({
          id: clientAccounts.id,
          clientName: clientAccounts.clientName,
          renewalDate: clientAccounts.renewalDate,
        })
        .from(clientAccounts)
        .where(eq(clientAccounts.orgId, orgId)),
      this.db
        .select({
          clientAccountId: clientAccountActivities.clientAccountId,
          lastActivityAt: max(clientAccountActivities.createdAt),
        })
        .from(clientAccountActivities)
        .innerJoin(clientAccounts, eq(clientAccountActivities.clientAccountId, clientAccounts.id))
        .where(eq(clientAccounts.orgId, orgId))
        .groupBy(clientAccountActivities.clientAccountId),
      this.db
        .select({ rating: csatResponses.rating, submittedAt: csatResponses.submittedAt })
        .from(csatResponses)
        .where(eq(csatResponses.orgId, orgId)),
      this.db
        .select({
          status: supportTickets.status,
          priority: supportTickets.priority,
          slaDeadline: supportTickets.slaDeadline,
          createdAt: supportTickets.createdAt,
          resolvedAt: supportTickets.resolvedAt,
          closedAt: supportTickets.closedAt,
        })
        .from(supportTickets)
        .where(eq(supportTickets.orgId, orgId)),
    ]);

    const config = configRow ?? getDefaultHealthConfig();
    const weights = config.weights;
    const thresholds = config.thresholds;
    const totalWeight = weights.sla + weights.csat + weights.activity + weights.renewal + weights.tickets || 1;

    const now = Date.now();

    const lastActivityMap = new Map<number, number>();
    for (const a of activityAggs) {
      if (a.lastActivityAt) lastActivityMap.set(a.clientAccountId, new Date(a.lastActivityAt).getTime());
    }

    const csatScaleMax = 5;
    let csatLatest: number | null = null;
    let csatLatestAt = 0;
    let csatSum = 0;
    let csatCount = 0;
    for (const r of csatAggs) {
      csatSum += r.rating;
      csatCount += 1;
      const at = r.submittedAt ? new Date(r.submittedAt).getTime() : 0;
      if (at >= csatLatestAt) {
        csatLatestAt = at;
        csatLatest = r.rating;
      }
    }
    const csatAvg = csatCount > 0 ? csatSum / csatCount : null;
    const orgCsatScore = computeCsatScore(csatLatest, csatAvg, csatScaleMax);

    const analyzedTickets = ticketRows.map((t) => {
      const priority = (t.priority ?? "MEDIUM").toUpperCase();
      const target = SLA_RESOLUTION_TARGETS[priority] ?? SLA_RESOLUTION_TARGETS.MEDIUM;
      const createdMs = t.createdAt ? new Date(t.createdAt).getTime() : now;
      const resolvedMs = t.resolvedAt
        ? new Date(t.resolvedAt).getTime()
        : t.closedAt
          ? new Date(t.closedAt).getTime()
          : null;
      const resolutionHours = resolvedMs !== null ? (resolvedMs - createdMs) / HOUR_MS : null;
      const hoursOpen = (now - createdMs) / HOUR_MS;
      const isResolved = t.status === "RESOLVED" || t.status === "CLOSED";
      const isOpen = !isResolved;
      let overdue = false;
      if (isOpen) {
        if (t.slaDeadline) overdue = now > new Date(t.slaDeadline).getTime();
        else overdue = hoursOpen > target;
      }
      return { resolved: resolvedMs !== null, resolutionHours, hoursOpen, target, isOpen, overdue };
    });

    const orgSlaScore = computeSlaScore(analyzedTickets);
    const openCount = analyzedTickets.filter((t) => t.isOpen).length;
    const overdueCount = analyzedTickets.filter((t) => t.overdue).length;
    const orgTicketsScore = computeTicketsScore(openCount, overdueCount);

    const results: HealthScoreResult[] = accounts.map((account) => {
      const lastActivityMs = lastActivityMap.get(account.id);
      const daysSinceLast = lastActivityMs !== undefined ? Math.floor((now - lastActivityMs) / DAY_MS) : null;
      const activityScore = computeActivityScore(daysSinceLast);

      const daysToRenewal = account.renewalDate
        ? Math.floor((new Date(`${account.renewalDate}T00:00:00`).getTime() - now) / DAY_MS)
        : null;
      const renewalScore = computeRenewalScore(daysToRenewal);

      const breakdown: HealthScoreBreakdown = {
        sla: orgSlaScore,
        csat: orgCsatScore,
        activity: activityScore,
        renewal: renewalScore,
        tickets: orgTicketsScore,
      };

      const weighted =
        breakdown.sla * weights.sla +
        breakdown.csat * weights.csat +
        breakdown.activity * weights.activity +
        breakdown.renewal * weights.renewal +
        breakdown.tickets * weights.tickets;
      const score = clamp(weighted / totalWeight);
      const status = mapStatus(score, thresholds);

      return { clientAccountId: account.id, clientName: account.clientName, score, status, breakdown };
    });

    if (results.length > 0) {
      await this.db.transaction(async (tx) => {
        await tx.delete(clientHealthScores).where(eq(clientHealthScores.orgId, orgId));
        await tx.insert(clientHealthScores).values(
          results.map((r) => ({
            orgId,
            clientAccountId: r.clientAccountId,
            score: r.score,
            status: r.status,
            breakdown: r.breakdown,
          })),
        );
      });
    }

    return results;
  }

  async getLatestHealthScores(orgId: string): Promise<{
    items: LatestHealthScore[];
    summary: HealthScoresSummary;
  }> {
    const [accounts, scores] = await Promise.all([
      this.db
        .select({ id: clientAccounts.id, clientName: clientAccounts.clientName })
        .from(clientAccounts)
        .where(eq(clientAccounts.orgId, orgId)),
      this.db
        .select({
          clientAccountId: clientHealthScores.clientAccountId,
          score: clientHealthScores.score,
          status: clientHealthScores.status,
          breakdown: clientHealthScores.breakdown,
          computedAt: clientHealthScores.computedAt,
        })
        .from(clientHealthScores)
        .where(eq(clientHealthScores.orgId, orgId)),
    ]);

    const nameMap = new Map(accounts.map((a) => [a.id, a.clientName]));
    const latestMap = new Map<number, LatestHealthScore>();
    for (const s of scores) {
      const computedMs = new Date(s.computedAt).getTime();
      const existing = latestMap.get(s.clientAccountId);
      if (!existing || computedMs > new Date(existing.computedAt).getTime()) {
        latestMap.set(s.clientAccountId, {
          clientAccountId: s.clientAccountId,
          clientName: nameMap.get(s.clientAccountId) ?? "Unknown account",
          score: s.score,
          status: s.status,
          breakdown: s.breakdown,
          computedAt: new Date(s.computedAt).toISOString(),
        });
      }
    }

    const items = Array.from(latestMap.values()).sort((a, b) => a.score - b.score);
    const total = items.length;
    const healthy = items.filter((i) => i.status === "healthy").length;
    const atRisk = items.filter((i) => i.status === "at_risk").length;
    const critical = items.filter((i) => i.status === "critical").length;
    const avgScore = total > 0 ? Math.round(items.reduce((sum, i) => sum + i.score, 0) / total) : 0;

    return { items, summary: { healthy, atRisk, critical, total, avgScore } };
  }

  async getOrgHealthConfig(orgId: string): Promise<{
    weights: HealthScoreWeights;
    thresholds: HealthScoreThresholds;
    isDefault: boolean;
  }> {
    const row = await this.db.query.healthScoreConfig.findFirst({ where: eq(healthScoreConfig.orgId, orgId) });
    if (!row) {
      const defaults = getDefaultHealthConfig();
      return { ...defaults, isDefault: true };
    }
    return { weights: row.weights, thresholds: row.thresholds, isDefault: false };
  }

  async upsertOrgHealthConfig(
    orgId: string,
    userId: string,
    weights: HealthScoreWeights,
    thresholds: HealthScoreThresholds,
  ): Promise<{ weights: HealthScoreWeights; thresholds: HealthScoreThresholds }> {
    const [row] = await this.db
      .insert(healthScoreConfig)
      .values({ orgId, weights, thresholds, updatedBy: userId })
      .onConflictDoUpdate({
        target: healthScoreConfig.orgId,
        set: { weights, thresholds, updatedBy: userId, updatedAt: new Date() },
      })
      .returning({ weights: healthScoreConfig.weights, thresholds: healthScoreConfig.thresholds });
    return { weights: row.weights, thresholds: row.thresholds };
  }
}
