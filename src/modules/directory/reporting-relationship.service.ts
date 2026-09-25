import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";
import { logger } from "../../common/logger/logger.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { OrgHierarchyCacheService } from "../../common/cache/org-hierarchy-cache.service";
import { hrReportingLines, type ReportingLineSource } from "../../db/schema";
import {
  lockReportingLines,
  writePrimaryLines,
  writeSecondaryLines,
  type LineProvenance,
} from "../../common/hr/sync-canonical-reporting-line";
import { orgBusinessDate } from "../hr/time/attendance-business-date";
import { ReportingLineService } from "./reporting-line.service";
import { ReportingManagerPolicyService } from "./reporting-manager-policy.service";
import {
  cyclicProposals,
  inForceOn,
  primaryChangeCounts,
  readReportingManagerPolicy,
  relationshipsBetween,
  subjectEmployments,
  topLevelRolesBetween,
  type RelationshipRow,
  type SubjectEmployment,
  type TopLevelRoleRow,
} from "./reporting-line-queries";
import { evaluateRelationshipCommand } from "./reporting-relationship-rules";
import { invalidateReportingReads } from "./reporting-line-cache";
import { ReportingLineException, rethrowReportingLineWriteError } from "./reporting-line-errors";
import { endTopLevelRoles, openTopLevelRole } from "./reporting-relationship-top-level";
import { actorKey, actorUserIdOf, recordRelationshipChange } from "./reporting-relationship-audit";
import {
  REPORTING_LINE_ERROR_CODES as CODES,
  REPORTING_LINE_EVENTS,
  type ReportingActor,
  type RelationshipSnapshot,
  type RelationshipValidation,
  type SetRelationshipsCommand,
  type SetRelationshipsResult,
} from "./reporting-line.types";

interface Evaluated {
  validation: RelationshipValidation;
  subject: SubjectEmployment | undefined;
  before: RelationshipSnapshot;
  secondary: Array<{ managerEmploymentId: number; label: string | null }>;
}

function snapshotOf(rows: readonly RelationshipRow[], topLevel: TopLevelRoleRow | undefined): RelationshipSnapshot {
  const primary = rows.find((row) => row.primary) ?? null;
  return {
    primary: primary ? { lineId: primary.lineId, managerUserId: primary.managerUserId, managerEmploymentId: primary.managerEmploymentId } : null,
    secondary: rows
      .filter((row) => !row.primary)
      .map((row) => ({ lineId: row.lineId, managerUserId: row.managerUserId, managerEmploymentId: row.managerEmploymentId, label: row.label })),
    topLevel: primary === null && topLevel ? { reason: topLevel.reason, effectiveFrom: topLevel.effectiveFrom } : null,
  };
}

function secondarySourceOf(cmd: SetRelationshipsCommand): ReportingLineSource {
  if (cmd.secondarySource) return cmd.secondarySource;
  return cmd.source === "ONBOARDING_FALLBACK" ? "ONBOARDING_SELECTED" : cmd.source;
}

function sameSnapshot(a: RelationshipSnapshot, b: RelationshipSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

@Injectable()
export class ReportingRelationshipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reportingLines: ReportingLineService,
    private readonly policies: ReportingManagerPolicyService,
    @Inject(AuditService) private readonly audit: Pick<AuditService, "logCritical">,
    private readonly hierarchyCache: OrgHierarchyCacheService,
    private readonly cache: CacheService,
  ) {}

  /**
   * THE write path for primary, secondary and top-level relationships. Validates every PRD §6 rule,
   * the secondary cap, cycles at the effective date and after, and the D4 frequency guard; then
   * writes lines, top-level roles and the audit rows in the caller's transaction.
   * Throws `ReportingLineException` with the first issue.
   */
  async setRelationships(tx: DbOrTx, cmd: SetRelationshipsCommand): Promise<SetRelationshipsResult> {
    await lockReportingLines(tx, cmd.orgId);
    const [evaluated] = await this.evaluate(tx, cmd.orgId, [cmd]);
    const { validation, subject } = evaluated;
    if (!validation.ok || !subject || validation.employmentId === null) {
      const issue = validation.issues[0];
      logger.warn("[hrm-15] reporting line change refused", { event: "hr.reporting_line.refused", orgId: cmd.orgId, code: issue?.code, source: cmd.source });
      throw ReportingLineException.of(issue);
    }

    const orgId = cmd.orgId;
    const employmentId = validation.employmentId;
    const actorUserId = actorUserIdOf(cmd.actor);
    const provenance: LineProvenance = {
      source: cmd.emergency ? "EMERGENCY_OVERRIDE" : cmd.source,
      reason: cmd.reason?.trim() || null,
      bulkJobId: cmd.bulkJobId ?? null,
      requestId: cmd.requestId ?? null,
      createdBy: actorUserId,
    };

    try {
      await writePrimaryLines(
        tx,
        orgId,
        [{ employmentId, managerEmploymentId: validation.primaryManagerEmploymentId }],
        { from: cmd.effectiveFrom, to: cmd.effectiveTo ?? null },
        provenance,
      );
      if (cmd.primaryManagerUserId === null) await openTopLevelRole(tx, orgId, employmentId, cmd.topLevelReason?.trim() ?? "", cmd.effectiveFrom, actorUserId);
      else await endTopLevelRoles(tx, orgId, employmentId, cmd.effectiveFrom, actorUserId);
      if (cmd.secondary !== undefined || cmd.primaryManagerUserId === null)
        await writeSecondaryLines(tx, orgId, employmentId, evaluated.secondary, cmd.effectiveFrom, {
          ...provenance,
          source: cmd.emergency ? "EMERGENCY_OVERRIDE" : secondarySourceOf(cmd),
        });
    } catch (error) {
      rethrowReportingLineWriteError(error);
    }

    const [afterRows, afterTopLevel] = await Promise.all([
      relationshipsBetween(tx, orgId, [employmentId], cmd.effectiveFrom, cmd.effectiveFrom),
      topLevelRolesBetween(tx, orgId, [employmentId], cmd.effectiveFrom, cmd.effectiveFrom),
    ]);
    const after = snapshotOf(afterRows, afterTopLevel[0]);
    const changed = !sameSnapshot(evaluated.before, after);
    const result: SetRelationshipsResult = {
      subjectUserId: subject.userId,
      employmentId,
      before: evaluated.before,
      after,
      changed,
      primaryChanged: validation.primaryChanged,
      warnings: validation.warnings,
    };
    if (changed) {
      await recordRelationshipChange(this.audit, cmd, result, validation);
      // Every writer routes through here, so no caller can forget the hierarchy and list reads.
      await invalidateReportingReads(this.hierarchyCache, this.cache, orgId);
    }
    return result;
  }

  /** Preview: every rule `setRelationships` applies, for up to a whole upload, with no writes. */
  async validateMany(orgId: string, commands: readonly SetRelationshipsCommand[], db: DbOrTx = this.db): Promise<RelationshipValidation[]> {
    return (await this.evaluate(db, orgId, commands)).map((entry) => entry.validation);
  }

  async countPrimaryChangesLast24h(orgId: string, employmentIds: readonly number[], db: DbOrTx = this.db): Promise<Map<number, number>> {
    return primaryChangeCounts(db, orgId, employmentIds);
  }

  /** HR accepts a fallback primary as the real manager: the line stays, the "temporary" marker goes. */
  async confirmFallback(tx: DbOrTx, cmd: { orgId: string; actor: ReportingActor; subjectUserId: string }): Promise<{ lineId: number | null; confirmed: boolean }> {
    const [subject] = await subjectEmployments(tx, cmd.orgId, { userIds: [cmd.subjectUserId] });
    if (!subject) throw new ReportingLineException(CODES.EMPLOYEE_NOT_FOUND, "This person is not an employee of the organization.");
    const today = await orgBusinessDate(this.db, cmd.orgId);
    const actorUserId = actorUserIdOf(cmd.actor);
    const [line] = await tx
      .update(hrReportingLines)
      .set({ fallbackConfirmedAt: new Date(), fallbackConfirmedBy: actorUserId, updatedAt: new Date() })
      .where(
        and(
          eq(hrReportingLines.orgId, cmd.orgId),
          eq(hrReportingLines.employmentId, subject.employmentId),
          eq(hrReportingLines.lineType, "primary"),
          eq(hrReportingLines.source, "ONBOARDING_FALLBACK"),
          sql`${hrReportingLines.fallbackConfirmedAt} IS NULL`,
          sql`${hrReportingLines.effectiveFrom} <= ${today}::date`,
          gte(hrReportingLines.effectiveTo, today),
        ),
      )
      .returning({ id: hrReportingLines.id });
    if (!line) return { lineId: null, confirmed: false };
    await invalidateReportingReads(this.hierarchyCache, this.cache, cmd.orgId);
    await this.audit.logCritical({
      action: REPORTING_LINE_EVENTS.FALLBACK_CONFIRMED,
      ...(actorUserId ? { userId: actorUserId } : { userId: null, systemActor: actorKey(cmd.actor) }),
      orgId: cmd.orgId,
      targetType: "employee",
      targetId: cmd.subjectUserId,
      metadata: { lineId: line.id, employmentId: subject.employmentId },
    });
    return { lineId: line.id, confirmed: true };
  }

  private async evaluate(db: DbOrTx, orgId: string, commands: readonly SetRelationshipsCommand[]): Promise<Evaluated[]> {
    const policy = await readReportingManagerPolicy(db, orgId);
    const byUser = commands.flatMap((cmd) => ("subjectUserId" in cmd ? [cmd.subjectUserId] : []));
    const byEmployment = commands.flatMap((cmd) => ("subjectEmploymentId" in cmd ? [cmd.subjectEmploymentId] : []));
    const subjects = [
      ...(byUser.length > 0 ? await subjectEmployments(db, orgId, { userIds: byUser }) : []),
      ...(byEmployment.length > 0 ? await subjectEmployments(db, orgId, { employmentIds: byEmployment }) : []),
    ];
    const subjectOf = (cmd: SetRelationshipsCommand): SubjectEmployment | undefined =>
      "subjectUserId" in cmd
        ? subjects.find((subject) => subject.userId === cmd.subjectUserId)
        : subjects.find((subject) => subject.employmentId === cmd.subjectEmploymentId);

    const managerUserIds = commands.flatMap((cmd) => [
      ...(cmd.primaryManagerUserId ? [cmd.primaryManagerUserId] : []),
      ...(cmd.secondary ?? []).map((entry) => entry.managerUserId),
    ]);
    const managerChecks = await this.reportingLines.checkManagers(orgId, managerUserIds, db);
    const managerEmploymentIds = [...managerChecks.values()].flatMap((check) => (check.ok ? [check.managerEmploymentId] : []));
    const managerEmployments = new Map(
      (await subjectEmployments(db, orgId, { employmentIds: managerEmploymentIds })).map((row) => [row.employmentId, row]),
    );

    const employmentIds = subjects.map((subject) => subject.employmentId);
    const days = commands.map((cmd) => cmd.effectiveFrom).sort();
    const firstDay = days[0] ?? "";
    const lastDay = days[days.length - 1] ?? "";
    const [lines, roles] = await Promise.all([
      relationshipsBetween(db, orgId, employmentIds, firstDay, lastDay),
      topLevelRolesBetween(db, orgId, employmentIds, firstDay, lastDay),
    ]);
    const changes = await primaryChangeCounts(db, orgId, employmentIds);

    const proposals = commands.flatMap((cmd, key) => {
      const subject = subjectOf(cmd);
      const check = cmd.primaryManagerUserId ? managerChecks.get(cmd.primaryManagerUserId) : undefined;
      return subject && check?.ok && check.managerEmploymentId !== subject.employmentId
        ? [{ key, subjectEmploymentId: subject.employmentId, managerEmploymentId: check.managerEmploymentId, from: cmd.effectiveFrom }]
        : [];
    });
    const cyclic = await cyclicProposals(db, orgId, proposals);

    const elevated = new Map<string, boolean>();
    for (const cmd of commands)
      if (!elevated.has(actorKey(cmd.actor))) elevated.set(actorKey(cmd.actor), await this.policies.isElevated(cmd.actor));

    return commands.map((cmd, key) => {
      const subject = subjectOf(cmd);
      const rows = subject ? lines.filter((row) => row.employmentId === subject.employmentId && inForceOn(row, cmd.effectiveFrom)) : [];
      const role = subject ? roles.find((row) => row.employmentId === subject.employmentId && inForceOn(row, cmd.effectiveFrom)) : undefined;
      const validation = evaluateRelationshipCommand(cmd, {
        policy,
        subject,
        managerChecks,
        managerEmployments,
        currentPrimary: rows.find((row) => row.primary) ?? null,
        currentSecondary: rows.filter((row) => !row.primary),
        changesLast24h: subject ? changes.get(subject.employmentId) ?? 0 : 0,
        cyclic: cyclic.has(key),
        elevated: elevated.get(actorKey(cmd.actor)) ?? false,
        system: "system" in cmd.actor,
      });
      const secondary = (cmd.secondary ?? []).flatMap((entry) => {
        const check = managerChecks.get(entry.managerUserId);
        return check?.ok ? [{ managerEmploymentId: check.managerEmploymentId, label: entry.label?.trim() || null }] : [];
      });
      return { validation, subject, before: snapshotOf(rows, role), secondary };
    });
  }
}
