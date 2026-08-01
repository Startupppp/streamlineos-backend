import { Inject, Injectable } from "@nestjs/common";
import { auditLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { getTenantContext, withTenant } from "../tenant";
import { logger } from "../logger/logger.service";

export interface AuditEntry {
  action: string;
  userId: string;
  orgId?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  actorUserId?: string | null;
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

  log(entry: AuditEntry): void {
    void this.write(entry).catch((error: unknown) =>
      logger.error("audit.log failed", { error, action: entry.action }),
    );
  }

  async logCritical(entry: AuditEntry): Promise<void> {
    await this.write(entry);
  }

  private async write(entry: AuditEntry): Promise<void> {
    const values = this.buildValues(entry);
    const orgId = entry.orgId ?? null;

    if (orgId && !getTenantContext()) {
      await withTenant(this.db, { orgId, audience: "INTERNAL" }, async (tx) => {
        await tx.insert(auditLogs).values(values);
      });
      return;
    }

    await this.db.insert(auditLogs).values(values);
  }

  private buildValues(entry: AuditEntry) {
    return {
      action: entry.action,
      userId: entry.userId,
      orgId: entry.orgId ?? null,
      targetId: entry.targetId ?? null,
      targetType: entry.targetType ?? null,
      actorUserId: entry.actorUserId ?? null,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      metadata: this.buildMetadata(entry),
      ipAddress: entry.ipAddress ?? null,
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
