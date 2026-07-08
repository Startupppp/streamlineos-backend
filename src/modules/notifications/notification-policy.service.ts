import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { notificationPolicyDefaults, notificationAuditLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpsertPolicyInput } from "./dto/policy.schemas";

@Injectable()
export class NotificationPolicyService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db.query.notificationPolicyDefaults.findMany({
      where: eq(notificationPolicyDefaults.orgId, orgId),
    });
  }

  async upsert(orgId: string, userId: string, dto: UpsertPolicyInput) {
    const scopeType = dto.scopeType ?? "ORG";
    const scopeId = dto.scopeId ?? null;
    const existing = await this.db.query.notificationPolicyDefaults.findFirst({
      where: and(
        eq(notificationPolicyDefaults.orgId, orgId),
        eq(notificationPolicyDefaults.scopeType, scopeType),
        scopeId === null ? isNull(notificationPolicyDefaults.scopeId) : eq(notificationPolicyDefaults.scopeId, scopeId),
      ),
    });

    const values = {
      orgId,
      scopeType,
      scopeId,
      ...(dto.defaultChannels !== undefined && { defaultChannels: dto.defaultChannels }),
      ...(dto.eventOverrides !== undefined && { eventOverrides: dto.eventOverrides }),
      ...(dto.categoryOverrides !== undefined && { categoryOverrides: dto.categoryOverrides }),
      ...(dto.moduleOverrides !== undefined && { moduleOverrides: dto.moduleOverrides }),
      ...(dto.canUserOverride !== undefined && { canUserOverride: dto.canUserOverride }),
      createdBy: userId,
    };

    let row;
    if (existing) {
      [row] = await this.db
        .update(notificationPolicyDefaults)
        .set(values)
        .where(eq(notificationPolicyDefaults.id, existing.id))
        .returning();
    } else {
      [row] = await this.db.insert(notificationPolicyDefaults).values(values).returning();
    }

    await this.db.insert(notificationAuditLogs).values({
      orgId,
      actorId: userId,
      action: existing ? "policy.updated" : "policy.created",
      metadata: { entityType: "policy", scopeType, scopeId },
    });
    return row;
  }
}
