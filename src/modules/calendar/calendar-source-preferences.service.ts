import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { calendarSourcePreferences, organizationMembers } from "../../db/schema";

@Injectable()
export class CalendarSourcePreferencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveMembershipId(orgId: string, userId: string): Promise<number | null> {
    const row = await this.db.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    });
    return row?.id ?? null;
  }

  async getDisabledKeys(orgId: string, userId: string): Promise<Set<string>> {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    if (membershipId === null) return new Set();
    const rows = await this.db
      .select({ sourceKey: calendarSourcePreferences.sourceKey })
      .from(calendarSourcePreferences)
      .where(
        and(
          eq(calendarSourcePreferences.orgId, orgId),
          eq(calendarSourcePreferences.membershipId, membershipId),
          eq(calendarSourcePreferences.enabled, false),
        ),
      );
    return new Set(rows.map((r) => r.sourceKey));
  }

  async setPreference(
    orgId: string,
    userId: string,
    sourceKey: string,
    enabled: boolean,
  ): Promise<void> {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    if (membershipId === null) return;
    if (enabled) {
      await this.db
        .delete(calendarSourcePreferences)
        .where(
          and(
            eq(calendarSourcePreferences.orgId, orgId),
            eq(calendarSourcePreferences.membershipId, membershipId),
            eq(calendarSourcePreferences.sourceKey, sourceKey),
          ),
        );
    } else {
      await this.db
        .insert(calendarSourcePreferences)
        .values({ orgId, membershipId, sourceKey, enabled: false })
        .onConflictDoUpdate({
          target: [
            calendarSourcePreferences.orgId,
            calendarSourcePreferences.membershipId,
            calendarSourcePreferences.sourceKey,
          ],
          set: { enabled: false, updatedAt: new Date() },
        });
    }
  }
}
