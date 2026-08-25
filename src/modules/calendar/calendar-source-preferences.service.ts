import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { calendarSourcePreferences } from "../../db/schema";

@Injectable()
export class CalendarSourcePreferencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getDisabledKeys(orgId: string, userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ sourceKey: calendarSourcePreferences.sourceKey })
      .from(calendarSourcePreferences)
      .where(
        and(
          eq(calendarSourcePreferences.orgId, orgId),
          eq(calendarSourcePreferences.userId, userId),
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
    if (enabled) {
      await this.db
        .delete(calendarSourcePreferences)
        .where(
          and(
            eq(calendarSourcePreferences.orgId, orgId),
            eq(calendarSourcePreferences.userId, userId),
            eq(calendarSourcePreferences.sourceKey, sourceKey),
          ),
        );
    } else {
      await this.db
        .insert(calendarSourcePreferences)
        .values({ orgId, userId, sourceKey, enabled: false })
        .onConflictDoUpdate({
          target: [
            calendarSourcePreferences.orgId,
            calendarSourcePreferences.userId,
            calendarSourcePreferences.sourceKey,
          ],
          set: { enabled: false, updatedAt: new Date() },
        });
    }
  }
}
