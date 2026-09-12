import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { autonomySettings } from "../../db/schema";
import {
  AUTONOMY_SETTINGS_DEFAULTS,
} from "../../db/schema/crm/autonomy-scoring";
import { normaliseSampleRate } from "./shadow-scoring";

@Injectable()
export class AutonomySettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async settingsFor(organizationId: string) {
    const [row] = await this.db
      .select()
      .from(autonomySettings)
      .where(eq(autonomySettings.organizationId, organizationId))
      .limit(1);

    return {
      shadowSampleRate: row
        ? normaliseSampleRate(row.shadowSampleRate)
        : AUTONOMY_SETTINGS_DEFAULTS.shadowSampleRate,
      shadowDailyCap: row?.shadowDailyCap ?? AUTONOMY_SETTINGS_DEFAULTS.shadowDailyCap,
      holdWindowSeconds: row?.holdWindowSeconds ?? AUTONOMY_SETTINGS_DEFAULTS.holdWindowSeconds,
      /**
       * `??` and not `||`, because `false` is the answer here rather than the
       * absence of one — and it is also the default, so the two are only
       * distinguishable by which operator this line uses.
       */
      autoQuoteEnabled: row?.autoQuoteEnabled ?? AUTONOMY_SETTINGS_DEFAULTS.autoQuoteEnabled,
    };
  }

  async updateSettings(
    organizationId: string,
    patch: {
      shadowSampleRate?: number;
      shadowDailyCap?: number;
      holdWindowSeconds?: number;
      autoQuoteEnabled?: boolean;
    },
  ) {
    await this.db
      .insert(autonomySettings)
      .values({
        organizationId,
        ...(patch.shadowSampleRate !== undefined
          ? { shadowSampleRate: patch.shadowSampleRate.toFixed(3) }
          : {}),
        ...(patch.shadowDailyCap !== undefined ? { shadowDailyCap: patch.shadowDailyCap } : {}),
        ...(patch.holdWindowSeconds !== undefined
          ? { holdWindowSeconds: patch.holdWindowSeconds }
          : {}),
        ...(patch.autoQuoteEnabled !== undefined
          ? { autoQuoteEnabled: patch.autoQuoteEnabled }
          : {}),
      })
      .onConflictDoUpdate({
        target: autonomySettings.organizationId,
        set: {
          ...(patch.shadowSampleRate !== undefined
            ? { shadowSampleRate: patch.shadowSampleRate.toFixed(3) }
            : {}),
          ...(patch.shadowDailyCap !== undefined ? { shadowDailyCap: patch.shadowDailyCap } : {}),
          ...(patch.holdWindowSeconds !== undefined
            ? { holdWindowSeconds: patch.holdWindowSeconds }
            : {}),
          ...(patch.autoQuoteEnabled !== undefined
            ? { autoQuoteEnabled: patch.autoQuoteEnabled }
            : {}),
          updatedAt: new Date(),
        },
      });

    return this.settingsFor(organizationId);
  }
}
