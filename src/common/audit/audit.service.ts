import { Inject, Injectable } from "@nestjs/common";
import { auditLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../logger/logger.service";

export interface AuditEntry {
  action: string;
  userId: string;
  orgId?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  log(entry: AuditEntry): void {
    void this.db
      .insert(auditLogs)
      .values({
        action: entry.action,
        userId: entry.userId,
        orgId: entry.orgId ?? null,
        targetId: entry.targetId ?? null,
        targetType: entry.targetType ?? null,
        metadata: entry.metadata ?? {},
        ipAddress: entry.ipAddress ?? null,
      })
      .catch((error: unknown) => logger.error("audit.log failed", { error, action: entry.action }));
  }
}
