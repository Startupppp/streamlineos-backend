import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { notificationPreferenceRules } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { NotificationChannel } from "./notification.types";

export type PreferenceScopeType = "EVENT" | "MODULE" | "CATEGORY";
export type PreferenceMode = "ON" | "OFF" | "DIGEST";

export interface PreferenceRuleInput {
  scopeType: PreferenceScopeType;
  scopeKey: string;
  channel: NotificationChannel;
  mode: PreferenceMode;
}

/**
 * SCH-003. Read and write the normalised preference rules that replaced the four
 * JSONB blobs. Self-scoped throughout: every method takes the caller's own
 * `(orgId, userId)` from the bearer token and never accepts a subject id, so one user
 * cannot read or edit another's preferences (§6).
 */
@Injectable()
export class NotificationPreferenceRulesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private memberPredicate(userId: string, membershipId: number | null | undefined) {
    if (membershipId != null)
      return or(
        eq(notificationPreferenceRules.membershipId, membershipId),
        and(isNull(notificationPreferenceRules.membershipId), eq(notificationPreferenceRules.userId, userId)),
      );
    return eq(notificationPreferenceRules.userId, userId);
  }

  list(orgId: string, userId: string, membershipId?: number | null) {
    return this.db
      .select()
      .from(notificationPreferenceRules)
      .where(and(eq(notificationPreferenceRules.orgId, orgId), this.memberPredicate(userId, membershipId)));
  }

  async set(orgId: string, userId: string, input: PreferenceRuleInput, membershipId?: number | null) {
    if (input.mode === "ON") {
      await this.db
        .delete(notificationPreferenceRules)
        .where(
          and(
            eq(notificationPreferenceRules.orgId, orgId),
            this.memberPredicate(userId, membershipId),
            eq(notificationPreferenceRules.scopeType, input.scopeType),
            eq(notificationPreferenceRules.scopeKey, input.scopeKey),
            eq(notificationPreferenceRules.channel, input.channel),
          ),
        );
    } else {
      await this.db
        .insert(notificationPreferenceRules)
        .values({ orgId, userId, membershipId: membershipId ?? null, ...input, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [
            notificationPreferenceRules.orgId,
            notificationPreferenceRules.userId,
            notificationPreferenceRules.scopeType,
            notificationPreferenceRules.scopeKey,
            notificationPreferenceRules.channel,
          ],
          set: { mode: input.mode, updatedAt: new Date() },
        });
    }

    // No cache to bust: routeMany queries preference rules directly on each dispatch
    // rather than through the cache layer, so a write is visible on the next send.
    return { ok: true };
  }
}
