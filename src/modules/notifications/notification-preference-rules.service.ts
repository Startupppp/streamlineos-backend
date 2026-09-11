import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
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

  private memberPredicate(membershipId: number | null | undefined) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    return eq(notificationPreferenceRules.membershipId, membershipId);
  }

  list(orgId: string, _userId: string, membershipId?: number | null) {
    return this.db
      .select()
      .from(notificationPreferenceRules)
      .where(and(eq(notificationPreferenceRules.orgId, orgId), this.memberPredicate(membershipId)))
      .limit(100);
  }

  async set(orgId: string, _userId: string, input: PreferenceRuleInput, membershipId?: number | null) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    if (input.mode === "ON") {
      await this.db
        .delete(notificationPreferenceRules)
        .where(
          and(
            eq(notificationPreferenceRules.orgId, orgId),
            this.memberPredicate(membershipId),
            eq(notificationPreferenceRules.scopeType, input.scopeType),
            eq(notificationPreferenceRules.scopeKey, input.scopeKey),
            eq(notificationPreferenceRules.channel, input.channel),
          ),
        );
    } else {
      await this.db
        .insert(notificationPreferenceRules)
        .values({ orgId, membershipId, ...input, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [
            notificationPreferenceRules.orgId,
            notificationPreferenceRules.membershipId,
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
