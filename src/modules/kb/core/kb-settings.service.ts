import { Inject, Injectable } from "@nestjs/common";
import { eq, inArray, isNotNull } from "drizzle-orm";
import { kbSettings, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

const DEFAULT_TRASH_RETENTION_DAYS = 30;

export type KbSettingsRow = {
  trashRetentionDays: number;
};

@Injectable()
export class KbSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getOrgSettings(orgId: string): Promise<KbSettingsRow> {
    const row = await this.db.query.kbSettings.findFirst({
      where: eq(kbSettings.orgId, orgId),
      columns: { trashRetentionDays: true },
    });
    return { trashRetentionDays: row?.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS };
  }

  async upsertOrgSettings(orgId: string, data: Partial<KbSettingsRow>): Promise<KbSettingsRow> {
    const [row] = await this.db
      .insert(kbSettings)
      .values({ orgId, ...data })
      .onConflictDoUpdate({
        target: kbSettings.orgId,
        set: { ...data, updatedAt: new Date() },
      })
      .returning({ trashRetentionDays: kbSettings.trashRetentionDays });
    return { trashRetentionDays: row?.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS };
  }

  async getOrgsWithTrashedPages(): Promise<{ orgId: string; trashRetentionDays: number }[]> {
    const orgsWithTrash = await this.db
      .selectDistinct({ orgId: kbPages.orgId })
      .from(kbPages)
      .where(isNotNull(kbPages.deletedAt));

    if (orgsWithTrash.length === 0) return [];

    const orgIds = orgsWithTrash.map((r) => r.orgId);

    const settingsRows = await this.db
      .select({ orgId: kbSettings.orgId, trashRetentionDays: kbSettings.trashRetentionDays })
      .from(kbSettings)
      .where(inArray(kbSettings.orgId, orgIds));

    const settingsMap = new Map(settingsRows.map((r) => [r.orgId, r.trashRetentionDays]));

    return orgIds.map((orgId) => ({
      orgId,
      trashRetentionDays: settingsMap.get(orgId) ?? DEFAULT_TRASH_RETENTION_DAYS,
    }));
  }
}
