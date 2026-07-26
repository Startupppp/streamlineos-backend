import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { PeriodsService } from "./periods.service";
import { BillingService, type BillingNarrativeWorkItem } from "./billing.service";
import { ReportsService } from "./reports.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AiUsageMeta } from "../ai/gateway/ai-gateway.types";
import { throwOnAiFailure } from "../ai/services/gateway-result.util";
import type { DescribeEntryInput, BillingNarrativeInput } from "./dto/ai.schemas";
import type { OverviewQuery } from "./dto/reports.schemas";

const DESCRIBE_FEATURE_KEY = "timesheets.describe-entry" as const;
const NARRATIVE_FEATURE_KEY = "timesheets.billing-narrative" as const;
const REPORTS_FEATURE_KEY = "timesheets.reports-narrative" as const;

function buildReportsSystemPrompt(): string {
  return [
    "You are a timesheet analyst. Narrate the pre-computed team timesheet overview for a manager in plain language.",
    "RULES:",
    "1. You MUST NOT compute, recalculate, or invent any numbers — every figure is provided in the evidence block.",
    "2. Cover: total hours logged, the billable vs non-billable split (billable ratio), the approval backlog (pending periods and pending hours), the number of active contributors, and the busiest projects and days.",
    "3. Flag anything a manager should act on: a low billable ratio, a large approval backlog, or a heavy concentration of hours on one project or day.",
    "4. Keep it to 3-6 sentences of plain prose. No markdown bullets, no preamble.",
  ].join("\n");
}

function buildReportsUserPrompt(evidence: unknown): string {
  return [
    "Team timesheet overview evidence — all numbers are pre-computed, do not modify them:",
    JSON.stringify(evidence, null, 2),
    "",
    "Write a 3-6 sentence plain-language narrative for a manager following the rules.",
  ].join("\n");
}

function buildNarrativeEvidence(items: BillingNarrativeWorkItem[]) {
  const byProject = new Map<string, { totalHours: number; notes: string[] }>();
  for (const item of items) {
    const group = byProject.get(item.projectName) ?? { totalHours: 0, notes: [] };
    group.totalHours += parseFloat(item.hours);
    const note = item.description?.trim();
    if (note) group.notes.push(note);
    byProject.set(item.projectName, group);
  }
  return [...byProject.entries()].map(([project, group]) => ({
    project,
    totalHours: Math.round(group.totalHours * 10) / 10,
    workItems: group.notes.slice(0, 60),
  }));
}

function buildNarrativeSystemPrompt(): string {
  return [
    "You are a billing assistant. Write a concise, professional, client-facing invoice narrative that summarises the work performed.",
    "RULES:",
    "1. Ground every statement ONLY in the provided work items — never invent deliverables, outcomes, or scope that is not present.",
    "2. If there are multiple projects, organise the narrative by project with a short heading per project.",
    "3. Summarise deliverables in clear business language; group similar items. Do not list every raw note verbatim and do not include internal jargon.",
    "4. Do not fabricate or recompute totals. You may reference the provided hours per project, but keep the focus on the work delivered.",
    "5. Keep it tight: a short paragraph (or 3-5 bullet points) per project. Plain prose or simple bullets, no invoice numbers, no pricing.",
  ].join("\n");
}

function buildNarrativeUserPrompt(evidence: unknown): string {
  return [
    "Work performed (grounded evidence — do not add anything not present here):",
    JSON.stringify(evidence, null, 2),
    "",
    "Write the client-facing invoice narrative following the rules.",
  ].join("\n");
}

function buildDescribeSystemPrompt(): string {
  return [
    "You are a timesheet assistant. Rewrite a worker's rough time-entry note into a clear, concise, professional description suitable for a client-facing invoice line or a manager's review.",
    "RULES:",
    "1. Stay grounded ONLY in the note and context provided — never invent work, deliverables, or outcomes that were not described.",
    "2. Do not restate the hours, project name, or billable flag — those are shown separately.",
    "3. Output one or two sentences of plain prose. No markdown, no bullet points, no preamble, no quotes.",
    "4. Use past tense, active voice (e.g. 'Implemented…', 'Reviewed…', 'Fixed…').",
  ].join("\n");
}

function buildDescribeUserPrompt(input: DescribeEntryInput): string {
  const context = [
    input.projectName ? `Project: ${input.projectName}` : null,
    input.ticketTitle ? `Ticket: ${input.ticketTitle}` : null,
    input.hours != null ? `Hours logged: ${input.hours}` : null,
    input.billable != null ? `Billable: ${input.billable ? "yes" : "no"}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    context ? `Context:\n${context}` : "Context: (none)",
    "",
    `Rough note:\n${input.description}`,
    "",
    "Rewrite the rough note as a polished description following the rules.",
  ].join("\n");
}

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
    private readonly billing: BillingService,
    private readonly reports: ReportsService,
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
      charge: true,
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

  async describeEntry(
    u: CurrentUserContext,
    input: DescribeEntryInput,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: u.orgId, userId: u.userId },
      feature: DESCRIBE_FEATURE_KEY,
      tier: "fast",
      maxTokens: 200,
      charge: true,
      prompt: {
        system: buildDescribeSystemPrompt(),
        user: buildDescribeUserPrompt(input),
        promptKey: DESCRIBE_FEATURE_KEY,
        promptVersion: 1,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async reportsNarrative(
    u: CurrentUserContext,
    query: OverviewQuery,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const overview = await this.reports.getOverview(u, query);
    if (overview.totalHours === 0) {
      throw new BadRequestException(
        "No timesheet data found for the selected range.",
      );
    }

    const evidence = {
      ...overview,
      byDay: overview.byDay.slice(-60),
      byProject: overview.byProject.slice(0, 40),
      dateRange: { start: query.startDate ?? null, end: query.endDate ?? null },
    };

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: u.orgId, userId: u.userId },
      feature: REPORTS_FEATURE_KEY,
      tier: "fast",
      maxTokens: 500,
      charge: true,
      prompt: {
        system: buildReportsSystemPrompt(),
        user: buildReportsUserPrompt(evidence),
        promptKey: REPORTS_FEATURE_KEY,
        promptVersion: 1,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async billingNarrative(
    u: CurrentUserContext,
    input: BillingNarrativeInput,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const items = await this.billing.getBillableWorkForNarrative(u, input);
    if (items.length === 0) {
      throw new BadRequestException(
        "No uninvoiced billable work found for the selected range.",
      );
    }

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: u.orgId, userId: u.userId },
      feature: NARRATIVE_FEATURE_KEY,
      tier: "fast",
      maxTokens: 600,
      charge: true,
      prompt: {
        system: buildNarrativeSystemPrompt(),
        user: buildNarrativeUserPrompt(buildNarrativeEvidence(items)),
        promptKey: NARRATIVE_FEATURE_KEY,
        promptVersion: 1,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    return { text: result.data, aiUsage: result.aiUsage };
  }
}
