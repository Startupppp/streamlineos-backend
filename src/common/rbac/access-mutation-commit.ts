import { auditLogs } from "../../db/schema";
import { getObservabilityContext } from "../observability/observability-context";
import { getImpersonationContext } from "../impersonation/impersonation-context";
import { registerAfterCommit } from "../tenant/tenant-context";
import { bumpPermissionsVersion, type DbOrTx } from "./access-invalidate";

export type { DbOrTx };

type AccessCommitActorFields =
  | { userId: string; systemActor?: never }
  | { userId?: null; systemActor: string };

export type CommitAccessAudit = AccessCommitActorFields & {
  action: string;
  targetId?: string | null;
  targetType?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
};

export interface CommitAccessOpts {
  audit?: CommitAccessAudit;
  afterCommit?: () => Promise<void>;
}

function buildAuditMetadata(
  entry: CommitAccessAudit,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry.metadata };
  if (entry.userId == null && entry.systemActor) out.systemActor = entry.systemActor;
  const impersonation = getImpersonationContext();
  if (impersonation) {
    out.impersonatedBy = impersonation.realActorUserId;
    out.impersonationSessionId = impersonation.impersonationSessionId;
  }
  return out;
}

export async function commitAccessChange(
  tx: DbOrTx,
  orgId: string,
  opts?: CommitAccessOpts,
): Promise<void> {
  await bumpPermissionsVersion(tx, orgId);

  if (opts?.audit) {
    const entry = opts.audit;
    const obs = getObservabilityContext();
    await tx.insert(auditLogs).values({
      action: entry.action,
      userId: entry.userId ?? null,
      orgId,
      targetId: entry.targetId ?? null,
      targetType: entry.targetType ?? entry.resourceType ?? null,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      metadata: buildAuditMetadata(entry),
      ipAddress: obs?.ipAddress ?? null,
      isPlatformEvent: false,
    });
  }

  if (opts?.afterCommit) {
    const work = opts.afterCommit;
    if (!registerAfterCommit(work)) await work();
  }
}
