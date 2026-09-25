import type { RelationshipRow, SubjectEmployment } from "./reporting-line-queries";
import { isActiveEmployeeLifecycle } from "./reporting-line-queries";
import type { ReportingLineIssue } from "./reporting-line-errors";
import {
  CHANGE_REASON_MAX_CHARS,
  CHANGE_REASON_MIN_CHARS,
  REPORTING_LINE_ERROR_CODES as CODES,
  REPORTING_LINE_WARNINGS,
  RELATIONSHIP_LABEL_MAX_CHARS,
  TOP_LEVEL_REASON_MAX_CHARS,
  type ManagerAssignmentCheck,
  type RelationshipValidation,
  type ReportingLineWarning,
  type ReportingManagerPolicy,
  type SetRelationshipsCommand,
} from "./reporting-line.types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Everything the rules need about one command, preloaded in batch by ReportingRelationshipService. */
export interface RelationshipRuleContext {
  policy: ReportingManagerPolicy;
  subject: SubjectEmployment | undefined;
  managerChecks: ReadonlyMap<string, ManagerAssignmentCheck>;
  /** Employment dates of every manager named, by employment id. */
  managerEmployments: ReadonlyMap<number, SubjectEmployment>;
  currentPrimary: RelationshipRow | null;
  currentSecondary: readonly RelationshipRow[];
  changesLast24h: number;
  cyclic: boolean;
  elevated: boolean;
  system: boolean;
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function meaningfulLength(value: string | null | undefined): number {
  return (value ?? "").replace(/\s/g, "").length;
}

function managerIssue(check: ManagerAssignmentCheck | undefined, who: string): ReportingLineIssue | null {
  if (!check) return { code: CODES.MANAGER_NOT_FOUND, message: `${who} is not an active member of this organization.` };
  if (check.ok) return null;
  if (check.reason === "self-reference") return { code: CODES.SELF_REFERENCE, message: check.message };
  if (check.reason === "manager-not-in-organization") return { code: CODES.MANAGER_NOT_FOUND, message: check.message };
  return { code: CODES.MANAGER_NOT_ELIGIBLE, message: check.message };
}

/** PRD §6.5: the manager must be employed on the effective date, judged against their scheduled dates. */
function windowIssue(employment: SubjectEmployment | undefined, effectiveFrom: string): ReportingLineIssue | null {
  if (!employment) return null;
  if (employment.joiningDate !== null && employment.joiningDate > effectiveFrom)
    return { code: CODES.MANAGER_NOT_ELIGIBLE, message: `The selected manager only joins on ${employment.joiningDate}, after the effective date.` };
  const leaves = [employment.lastWorkingDay, employment.exitDate].filter((day): day is string => day !== null).sort()[0];
  if (leaves !== undefined && leaves < effectiveFrom)
    return { code: CODES.MANAGER_NOT_ELIGIBLE, message: `The selected manager leaves on ${leaves}, before the effective date.` };
  return null;
}

function managerEmploymentOf(check: ManagerAssignmentCheck | undefined): number | null {
  return check?.ok ? check.managerEmploymentId : null;
}

/**
 * Every PRD §6 / D3 / D4 rule for one command, as a pure function. Issues are collected in the order
 * a person would fix them; the first one is what `setRelationships` throws.
 */
export function evaluateRelationshipCommand(cmd: SetRelationshipsCommand, ctx: RelationshipRuleContext): RelationshipValidation {
  const issues: ReportingLineIssue[] = [];
  const warnings: ReportingLineWarning[] = [];
  const subject = ctx.subject;
  const subjectUserId = "subjectUserId" in cmd ? cmd.subjectUserId : subject?.userId ?? null;

  if (!subject || !isActiveEmployeeLifecycle(subject.lifecycleStatus))
    issues.push({ code: CODES.EMPLOYEE_NOT_FOUND, message: "This person is not an active employee of the organization." });

  if (!isIsoDate(cmd.effectiveFrom))
    issues.push({ code: CODES.INVALID_EFFECTIVE_DATE, message: "The effective date must be a calendar date (YYYY-MM-DD)." });
  else if (cmd.effectiveTo && (!isIsoDate(cmd.effectiveTo) || cmd.effectiveTo < cmd.effectiveFrom))
    issues.push({ code: CODES.INVALID_EFFECTIVE_DATE, message: "The end date must be a calendar date on or after the effective date." });

  if ((cmd.reason ?? "").length > CHANGE_REASON_MAX_CHARS)
    issues.push({ code: CODES.CHANGE_REASON_REQUIRED, message: `The reason must be at most ${CHANGE_REASON_MAX_CHARS} characters.` });

  const topLevelReason = cmd.topLevelReason?.trim() ?? "";
  if (cmd.primaryManagerUserId === null) {
    if (!ctx.policy.allowTopLevelWithoutManager)
      issues.push({ code: CODES.TOP_LEVEL_NOT_ALLOWED, message: "This organization requires every employee to have a primary reporting manager." });
    else if (topLevelReason.length === 0)
      issues.push({ code: CODES.TOP_LEVEL_REASON_REQUIRED, message: "Give a reason why this employee has no reporting manager." });
    else if (topLevelReason.length > TOP_LEVEL_REASON_MAX_CHARS)
      issues.push({ code: CODES.TOP_LEVEL_REASON_REQUIRED, message: `The top-level reason must be at most ${TOP_LEVEL_REASON_MAX_CHARS} characters.` });
    if ((cmd.secondary ?? []).length > 0)
      issues.push({ code: CODES.TOP_LEVEL_WITH_MANAGER, message: "A top-level employee cannot also have secondary reporting managers." });
  } else if (topLevelReason.length > 0) {
    issues.push({ code: CODES.TOP_LEVEL_WITH_MANAGER, message: "A top-level employee cannot also have a primary reporting manager." });
  }

  let primaryEmployment: number | null = null;
  if (cmd.primaryManagerUserId !== null) {
    const check = ctx.managerChecks.get(cmd.primaryManagerUserId);
    const issue =
      cmd.primaryManagerUserId === subjectUserId
        ? { code: CODES.SELF_REFERENCE, message: "An employee cannot report to themselves." }
        : managerIssue(check, "The selected manager");
    primaryEmployment = managerEmploymentOf(check);
    if (issue) issues.push(issue);
    else if (primaryEmployment !== null && primaryEmployment === subject?.employmentId)
      issues.push({ code: CODES.SELF_REFERENCE, message: "An employee cannot report to themselves." });
    else {
      const late = primaryEmployment === null ? null : windowIssue(ctx.managerEmployments.get(primaryEmployment), cmd.effectiveFrom);
      if (late) issues.push(late);
      else if (ctx.cyclic)
        issues.push({ code: CODES.PRIMARY_CYCLE, message: "This reporting structure would create a circular management chain." });
    }
  }

  if (cmd.secondary !== undefined) {
    if (cmd.secondary.length > ctx.policy.maxSecondaryManagersPerEmployee)
      issues.push({
        code: CODES.SECONDARY_CAP_EXCEEDED,
        message: `This organization allows at most ${ctx.policy.maxSecondaryManagersPerEmployee} secondary reporting manager(s) per employee.`,
      });
    const seen = new Set<string>();
    for (const entry of cmd.secondary) {
      if (entry.managerUserId === subjectUserId)
        issues.push({ code: CODES.SELF_REFERENCE, message: "An employee cannot be their own secondary reporting manager." });
      else if (entry.managerUserId === cmd.primaryManagerUserId)
        issues.push({ code: CODES.SECONDARY_DUPLICATES_PRIMARY, message: "The primary reporting manager cannot also be a secondary manager." });
      else if (seen.has(entry.managerUserId))
        issues.push({ code: CODES.SECONDARY_DUPLICATE, message: "The same person is listed twice as a secondary manager." });
      else {
        const check = ctx.managerChecks.get(entry.managerUserId);
        const employment = managerEmploymentOf(check);
        const problem =
          managerIssue(check, "A selected secondary manager") ??
          (employment === null ? null : windowIssue(ctx.managerEmployments.get(employment), cmd.effectiveFrom));
        if (problem) issues.push(problem);
        if ((entry.label?.trim().length ?? 0) > RELATIONSHIP_LABEL_MAX_CHARS)
          issues.push({ code: CODES.MANAGER_ROW_FAILED, message: `A secondary relationship label must be at most ${RELATIONSHIP_LABEL_MAX_CHARS} characters.` });
      }
      seen.add(entry.managerUserId);
    }
  } else if (primaryEmployment !== null && ctx.currentSecondary.some((line) => line.managerEmploymentId === primaryEmployment)) {
    issues.push({ code: CODES.SECONDARY_DUPLICATES_PRIMARY, message: "The new primary manager is already a secondary manager. Remove them as a secondary manager first." });
  }

  const currentPrimaryEmployment = ctx.currentPrimary?.managerEmploymentId ?? null;
  const primaryChanged = currentPrimaryEmployment !== primaryEmployment;
  const guarded = primaryChanged && !cmd.skipFrequencyGuard && ctx.changesLast24h >= ctx.policy.requireReasonAfterChanges;

  const needsReason = guarded || Boolean(cmd.emergency);
  const needsElevation = Boolean(cmd.emergency) || (guarded && !ctx.system);
  if (guarded) warnings.push(REPORTING_LINE_WARNINGS.PRIMARY_CHANGE_THRESHOLD_EXCEEDED);
  if (cmd.emergency) warnings.push(REPORTING_LINE_WARNINGS.EMERGENCY_OVERRIDE);
  if (needsReason && meaningfulLength(cmd.reason) < CHANGE_REASON_MIN_CHARS)
    issues.push({
      code: CODES.CHANGE_REASON_REQUIRED,
      message: guarded
        ? `This employee's primary manager already changed ${ctx.changesLast24h} time(s) in the last 24 hours. Give a reason of at least ${CHANGE_REASON_MIN_CHARS} characters.`
        : `An emergency change needs a reason of at least ${CHANGE_REASON_MIN_CHARS} characters.`,
    });
  if (needsElevation && !ctx.elevated)
    issues.push({
      code: CODES.ELEVATED_AUTHORITY_REQUIRED,
      message: cmd.emergency
        ? "An emergency change needs an HR administrator or organization administrator."
        : "Changing a primary manager this often needs an HR administrator or organization administrator.",
    });
  if (cmd.source === "ONBOARDING_FALLBACK") warnings.push(REPORTING_LINE_WARNINGS.FALLBACK_ASSIGNED);

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    employmentId: subject?.employmentId ?? null,
    currentPrimaryManagerEmploymentId: currentPrimaryEmployment,
    primaryManagerEmploymentId: primaryEmployment,
    primaryChanged,
    primaryChangesLast24h: ctx.changesLast24h,
    requiresReason: needsReason,
  };
}
