import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { supportSettingsAuditLog, type SettingsAuditAction, type SettingsAuditEntityType } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";

@Injectable()
export class SupportSettingsAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Best-effort: a logging failure must never block the underlying settings write. */
  async record(
    orgId: string,
    userId: string | null,
    entityType: SettingsAuditEntityType,
    entityId: number | string,
    action: SettingsAuditAction,
    changes?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.insert(supportSettingsAuditLog).values({
        orgId,
        userId,
        entityType,
        entityId: String(entityId),
        action,
        changes: changes ?? null,
      });
    } catch (error) {
      logger.error("Failed to record support settings audit log entry", {
        orgId,
        entityType,
        entityId,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  list(orgId: string, entityType?: SettingsAuditEntityType, limit = 100) {
    return this.db.query.supportSettingsAuditLog.findMany({
      where: entityType
        ? and(eq(supportSettingsAuditLog.orgId, orgId), eq(supportSettingsAuditLog.entityType, entityType))
        : eq(supportSettingsAuditLog.orgId, orgId),
      orderBy: [desc(supportSettingsAuditLog.createdAt)],
      limit,
    });
  }
}
