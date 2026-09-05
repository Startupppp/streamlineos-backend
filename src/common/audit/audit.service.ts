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
import { reportError } from "../observability/error-reporter";

export interface AuditEntry {
  action: string;
  userId: string;
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

@Injectable()
export class AuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Best-effort telemetry only. Transactional/security audit must use logCritical. */
  log(entry: AuditEntry): void {
    const dispatch = () =>
      runOutsideTenantContext(() => this.write(entry)).catch((error: unknown) => {
        logger.error("audit.log failed", { error, action: entry.action });
        reportError(error, { action: entry.action });
      });
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
    return {
      action: entry.action,
      userId: entry.userId,
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
    if (entry.result !== undefined) enrichedMetadata.result = entry.result;
    if (entry.requestId) enrichedMetadata.requestId = entry.requestId;
    if (entry.userAgent) enrichedMetadata.userAgent = entry.userAgent;
    if (entry.before) enrichedMetadata.before = entry.before;
    if (entry.after) enrichedMetadata.after = entry.after;
    return enrichedMetadata;
  }
}
