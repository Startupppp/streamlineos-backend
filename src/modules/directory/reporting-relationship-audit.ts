import { AuditService } from "../../common/audit/audit.service";
import {
  REPORTING_LINE_EVENTS,
  type ReportingActor,
  type RelationshipValidation,
  type SetRelationshipsCommand,
  type SetRelationshipsResult,
} from "./reporting-line.types";

export function actorKey(actor: ReportingActor): string {
  return "system" in actor ? `system:${actor.system}` : `user:${actor.userId}`;
}

export function actorUserIdOf(actor: ReportingActor): string | null {
  return "system" in actor ? null : actor.userId;
}

export async function recordRelationshipChange(
  audit: Pick<AuditService, "logCritical">,
  cmd: SetRelationshipsCommand,
  result: SetRelationshipsResult,
  validation: RelationshipValidation,
): Promise<void> {
  const actorUserId = actorUserIdOf(cmd.actor);
  const who = actorUserId ? { userId: actorUserId } : { userId: null, systemActor: actorKey(cmd.actor) };
  const metadata = {
    employmentId: result.employmentId,
    effectiveFrom: cmd.effectiveFrom,
    effectiveTo: cmd.effectiveTo ?? null,
    source: cmd.emergency ? "EMERGENCY_OVERRIDE" : cmd.source,
    reason: cmd.reason?.trim() || null,
    topLevelReason: cmd.primaryManagerUserId === null ? cmd.topLevelReason?.trim() ?? null : null,
    bulkJobId: cmd.bulkJobId ?? null,
    requestId: cmd.requestId ?? null,
    emergency: Boolean(cmd.emergency),
    primaryChanged: result.primaryChanged,
    primaryChangesLast24h: validation.primaryChangesLast24h,
    warnings: result.warnings,
  };
  const target = { orgId: cmd.orgId, targetType: "employee", targetId: result.subjectUserId ?? String(result.employmentId) };
  await audit.logCritical({
    action: REPORTING_LINE_EVENTS.CHANGED,
    ...who,
    ...target,
    metadata,
    before: { ...result.before },
    after: { ...result.after },
  });
  if (cmd.emergency)
    await audit.logCritical({
      action: REPORTING_LINE_EVENTS.EMERGENCY_OVERRIDE,
      ...who,
      ...target,
      metadata: { ...metadata, severity: "high" },
      before: { ...result.before },
      after: { ...result.after },
    });
}
