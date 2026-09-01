import type { BillingNarrativeWorkItem } from "./billing.service";
import type { DescribeEntryInput } from "./dto/ai.schemas";

export function buildRejectionSystemPrompt(): string {
  return [
    "You are a team manager writing a brief, constructive rejection note for a submitted timesheet, addressed directly to the employee.",
    "RULES:",
    "1. Ground the feedback ONLY in the evidence — reference specific issues (days with no entries, unusually high hours on a day, a low billable ratio, or missing detail). Never invent problems that the evidence does not support.",
    "2. If the reviewer provided a note, honour its intent and expand it professionally.",
    "3. Be clear and actionable: tell the employee exactly what to correct before resubmitting. Keep a respectful, professional tone.",
    "4. Output 1-3 sentences of plain prose. No preamble, no greeting, no sign-off.",
  ].join("\n");
}

export function buildRejectionUserPrompt(evidence: unknown, note?: string): string {
  return [
    "Timesheet evidence (pre-computed, do not modify):",
    JSON.stringify(evidence, null, 2),
    "",
    note
      ? `Reviewer's note to incorporate: ${note}`
      : "The reviewer did not provide a note; infer the most likely issue(s) from the evidence.",
    "",
    "Write the constructive rejection note following the rules.",
  ].join("\n");
}

export function buildReportsSystemPrompt(): string {
  return [
    "You are a timesheet analyst. Narrate the pre-computed team timesheet overview for a manager in plain language.",
    "RULES:",
    "1. You MUST NOT compute, recalculate, or invent any numbers — every figure is provided in the evidence block.",
    "2. Cover: total hours logged, the billable vs non-billable split (billable ratio), the approval backlog (pending periods and pending hours), the number of active contributors, and the busiest projects and days.",
    "3. Flag anything a manager should act on: a low billable ratio, a large approval backlog, or a heavy concentration of hours on one project or day.",
    "4. Keep it to 3-6 sentences of plain prose. No markdown bullets, no preamble.",
  ].join("\n");
}

export function buildReportsUserPrompt(evidence: unknown): string {
  return [
    "Team timesheet overview evidence — all numbers are pre-computed, do not modify them:",
    JSON.stringify(evidence, null, 2),
    "",
    "Write a 3-6 sentence plain-language narrative for a manager following the rules.",
  ].join("\n");
}

export function buildNarrativeEvidence(items: BillingNarrativeWorkItem[]) {
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

export function buildNarrativeSystemPrompt(): string {
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

export function buildNarrativeUserPrompt(evidence: unknown): string {
  return [
    "Work performed (grounded evidence — do not add anything not present here):",
    JSON.stringify(evidence, null, 2),
    "",
    "Write the client-facing invoice narrative following the rules.",
  ].join("\n");
}

export function buildDescribeSystemPrompt(): string {
  return [
    "You are a timesheet assistant. Rewrite a worker's rough time-entry note into a clear, concise, professional description suitable for a client-facing invoice line or a manager's review.",
    "RULES:",
    "1. Stay grounded ONLY in the note and context provided — never invent work, deliverables, or outcomes that were not described.",
    "2. Do not restate the hours, project name, or billable flag — those are shown separately.",
    "3. Output one or two sentences of plain prose. No markdown, no bullet points, no preamble, no quotes.",
    "4. Use past tense, active voice (e.g. 'Implemented…', 'Reviewed…', 'Fixed…').",
  ].join("\n");
}

export function buildDescribeUserPrompt(input: DescribeEntryInput): string {
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

export function buildPeriodSummarySystemPrompt(): string {
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

export function buildPeriodSummaryUserPrompt(evidence: Record<string, unknown>): string {
  return [
    "Timesheet period evidence — all numbers are pre-computed, do not modify them:",
    JSON.stringify(evidence, null, 2),
    "",
    "Write a 3-5 sentence plain-language narrative for a reviewer. Highlight the billable ratio, any overtime, and any notable distribution patterns across projects or days. Do not invent numbers.",
  ].join("\n");
}

export type PeriodRow = {
  periodStart: string;
  periodEnd: string;
  status: string;
  totalHours: string;
  billableHours: string;
  nonBillableHours: string;
  orgId: string;
  user?: { name: string | null; email: string };
};

export type EntryRow = {
  date: string;
  hours: string;
  isBillable: boolean;
  billingType: string;
  project?: { id: number; name: string } | null;
};

export function buildEvidence(period: PeriodRow, entries: EntryRow[]) {
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
