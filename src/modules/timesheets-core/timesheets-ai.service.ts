import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { getFeatureCost } from "../ai/billing/ai-cost-catalog";
import { PeriodsService } from "./periods.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const FEATURE_KEY = "timesheets.period-summary" as const;

function buildSystemPrompt(): string {
  return [
    "You are a timesheet analyst. Your sole job is to narrate and explain pre-computed timesheet data in plain language for a reviewer.",
    "CRITICAL RULES you must never violate:",
    "1. You MUST NOT compute, recalculate, or invent any numbers. Every figure is provided to you in the evidence block.",
    "2. You MUST NOT contradict the evidence. Reference the exact hours and percentages given.",
    "3. Narrate what the evidence shows: how hours were distributed across projects and days, the billable vs non-billable split, any overtime, and whether utilisation looks notable.",
    "4. Flag unusual patterns (e.g. a single day with unusually high hours, projects with zero billable hours, missing entries on a working day).",
    "5. Keep the summary concise: 3-5 sentences maximum, in plain prose. No markdown bullets.",
  ].join("\n");
}

function buildUserPrompt(evidence: Record<string, unknown>): string {
  return [
    "Timesheet period evidence — all numbers are pre-computed, do not modify them:",
    JSON.stringify(evidence, null, 2),
    "",
    "Write a 3-5 sentence plain-language narrative for a reviewer. Highlight the billable ratio, any overtime, and any notable distribution patterns across projects or days. Do not invent numbers.",
  ].join("\n");
}

type PeriodRow = {
  periodStart: string;
  periodEnd: string;
  status: string;
  totalHours: string;
  billableHours: string;
  nonBillableHours: string;
  orgId: string;
  user?: { name: string | null; email: string };
};

type EntryRow = {
  date: string;
  hours: string;
  isBillable: boolean;
  billingType: string;
  project?: { id: number; name: string } | null;
};

function buildEvidence(period: PeriodRow, entries: EntryRow[]) {
  const totalH = parseFloat(period.totalHours);
  const billableH = parseFloat(period.billableHours);
  const nonBillableH = parseFloat(period.nonBillableHours);
  const billableRatio = totalH > 0 ? Math.round((billableH / totalH) * 100) : 0;

  const byDay = new Map<string, number>();
  const byProject = new Map<string, number>();

  for (const e of entries) {
    const h = parseFloat(e.hours);
    byDay.set(e.date, (byDay.get(e.date) ?? 0) + h);
    const projName = e.project?.name ?? "No project";
    byProject.set(projName, (byProject.get(projName) ?? 0) + h);
  }

  const entryCount = entries.length;
  const workingDays = byDay.size;
  const avgHoursPerDay = workingDays > 0 ? Math.round((totalH / workingDays) * 10) / 10 : 0;

  const highDays = [...byDay.entries()]
    .filter(([, h]) => h > 9)
    .map(([date, h]) => ({ date, hours: h }));

  return {
    employee: period.user?.name ?? period.user?.email ?? "Unknown",
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    status: period.status,
    totalHours: totalH,
    billableHours: billableH,
    nonBillableHours: nonBillableH,
    billableRatioPercent: billableRatio,
    entryCount,
    workingDaysLogged: workingDays,
    averageHoursPerDay: avgHoursPerDay,
    highHoursDays: highDays,
    hoursByProject: Object.fromEntries(byProject),
  };
}

@Injectable()
export class TimesheetsAiService {
  constructor(
    private readonly gateway: AiGatewayService,
    private readonly periods: PeriodsService,
  ) {}

  async summarizePeriod(u: CurrentUserContext, periodId: number): Promise<{ narration: string; evidence: Record<string, unknown> }> {
    const detail = await this.periods.getPeriod(u, periodId);
    if (!detail) throw new NotFoundException("Period not found");

    const { period, entries } = detail;

    if (period.orgId !== u.orgId) {
      throw new ForbiddenException("Access denied");
    }

    const evidence = buildEvidence(period, entries);
    const evidenceRecord: Record<string, unknown> = evidence;

    const result = await this.gateway.invokeText({
      actor: { orgId: u.orgId, userId: u.userId },
      feature: FEATURE_KEY,
      tier: "fast",
      maxTokens: 512,
      charge: {
        credits: getFeatureCost(FEATURE_KEY),
        idempotencyKey: `timesheets-summary-${u.orgId}-${periodId}-${randomUUID()}`,
      },
      redact: false,
      prompt: {
        system: buildSystemPrompt(),
        user: buildUserPrompt(evidenceRecord),
        promptKey: "timesheets.period-summary",
        promptVersion: 1,
      },
    });

    if (!result.ok) {
      throw new ServiceUnavailableException(result.message);
    }

    return { narration: result.data, evidence: evidenceRecord };
  }
}
