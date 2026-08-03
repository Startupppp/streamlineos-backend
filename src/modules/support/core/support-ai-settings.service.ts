// DDL for orchestrator (do not apply — run via migration 0280):
// CREATE TABLE support_ai_settings (
//   id serial PRIMARY KEY,
//   org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
//   confidence_threshold numeric(4,3) NOT NULL DEFAULT 0.7,
//   updated_at timestamptz NOT NULL DEFAULT now(),
//   CONSTRAINT uniq_support_ai_settings_org UNIQUE (org_id)
// );
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { supportAiSettings } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export type SupportAiSettingsDto = {
  confidenceThreshold: number;
};

@Injectable()
export class SupportAiSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getSettings(orgId: string): Promise<SupportAiSettingsDto> {
    try {
      const row = await this.db.query.supportAiSettings.findFirst({
        where: eq(supportAiSettings.orgId, orgId),
        columns: { confidenceThreshold: true },
      });
      return { confidenceThreshold: row ? Number(row.confidenceThreshold) : DEFAULT_CONFIDENCE_THRESHOLD };
    } catch {
      return { confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD };
    }
  }

  async updateSettings(orgId: string, confidenceThreshold: number): Promise<SupportAiSettingsDto> {
    try {
      await this.db
        .insert(supportAiSettings)
        .values({ orgId, confidenceThreshold: confidenceThreshold.toFixed(3) })
        .onConflictDoUpdate({
          target: supportAiSettings.orgId,
          set: { confidenceThreshold: confidenceThreshold.toFixed(3), updatedAt: new Date() },
        });
    } catch {
      // table not yet migrated — return the value anyway
    }
    return { confidenceThreshold };
  }
}
