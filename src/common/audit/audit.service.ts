import { Inject, Injectable } from "@nestjs/common";
import { auditLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  getTenantContext,
  registerAfterCommit,
  runOutsideTenantContext,
  withTenant,
} from "../tenant";
import { logger } from "../logger/logger.service";

interface AuditEntryFields {
  action: string;
  orgId?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  actorUserId?: string | null;
  actorMembershipId?: number | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  result?: "SUCCESS" | "FAILURE";
  requestId?: string | null;
  userAgent?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Who acted, as two mutually exclusive cases the compiler makes callers pick
 * between.
 *
 * `audit_logs.user_id` is nullable, because an unattended action — a cron
 * sweep, a public unsubscribe link — was not taken by any user and there is no
 * user id to write. It used to be NOT NULL, so the convention that grew around
 * it was the literal string "system"; nothing ever created that user, so every
 * such write raised a foreign-key violation, silently in `log` and fatally in
 * `logCritical`.
 *
 * A bare nullable id would trade that for a quieter defect: "no user acted" and
 * "a user acted and the id was lost" would look identical in the audit log. So
 * the system case names itself, the same shape `StageActor` and `ActivityActor`
 * already use, and the label lands in `metadata.systemActor` where a reviewer
 * reads it. A CHECK constraint holds the same rule at the table.
 */
type AuditActorFields =
  | { userId: string; systemActor?: never }
  | { userId?: null; systemActor: string };

export type AuditEntry = AuditEntryFields & AuditActorFields;

/**
 * The label an unattributed row gave itself, for readers that render an actor.
 *
 * `user_id` is null on those rows and the `users` join resolves to nothing, so
 * a reader with only the join has a blank where an actor goes. This is where
 * the name lives instead. Returns null for an attributed row, which has a real
 * user to render.
 */
export function systemActorLabel(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const label = metadata?.systemActor;
  return typeof label === "string" ? label : null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Best-effort telemetry only. Transactional/security audit must use logCritical. */
  log(entry: AuditEntry): void {
    const dispatch = () =>
      runOutsideTenantContext(() => this.write(entry)).catch(
        (error: unknown) =>
          logger.error("audit.log failed", { error, action: entry.action }),
      );
    if (!registerAfterCommit(dispatch)) void dispatch();
  }

  /** Awaited and transaction-aware; failures prevent the enclosing mutation from committing. */
  async logCritical(entry: AuditEntry): Promise<void> {
    await this.write(entry);
  }

  private async write(entry: AuditEntry): Promise<void> {
    const values = this.buildValues(entry);
    const orgId = values.orgId;

    if (orgId && !getTenantContext()) {
      await withTenant(this.db, { orgId, audience: "INTERNAL" }, async (tx) => {
        await tx.insert(auditLogs).values(values);
      });
      return;
    }

    await this.db.insert(auditLogs).values(values);
  }

  private buildValues(entry: AuditEntry) {
    const orgId = entry.orgId ?? null;
    const userId = entry.userId ?? null;

    /**
     * The types make this unreachable from TypeScript. It is here for the
     * callers that are not — a `log` from an untyped boundary would otherwise
     * reach the CHECK constraint and surface as a 23514 naming a column rather
     * than the entry that is wrong.
     */
    if (userId === null && !entry.systemActor) {
      throw new Error(
        `audit entry "${entry.action}" has no userId and no systemActor: an unattributed audit row must name the unattended path that acted`,
      );
    }

    return {
      action: entry.action,
      userId,
      orgId,
      targetId: entry.targetId ?? null,
      targetType: entry.targetType ?? null,
      actorUserId: entry.actorUserId ?? null,
      actorMembershipId: entry.actorMembershipId ?? null,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      metadata: this.buildMetadata(entry),
      ipAddress: entry.ipAddress ?? null,
      isPlatformEvent: orgId === null,
    };
  }

  private buildMetadata(entry: AuditEntry): Record<string, unknown> {
    const enrichedMetadata: Record<string, unknown> = { ...entry.metadata };
    if (entry.userId == null && entry.systemActor)
      enrichedMetadata.systemActor = entry.systemActor;
    if (entry.result !== undefined) enrichedMetadata.result = entry.result;
    if (entry.requestId) enrichedMetadata.requestId = entry.requestId;
    if (entry.userAgent) enrichedMetadata.userAgent = entry.userAgent;
    if (entry.before) enrichedMetadata.before = entry.before;
    if (entry.after) enrichedMetadata.after = entry.after;
    return enrichedMetadata;
  }
}
