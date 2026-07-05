import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { chatOrgSettings } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { UpdateChatOrgSettingsInput } from "./dto/chat.schemas";

const DEFAULT_CHAT_ORG_SETTINGS = {
  defaultNotificationPreference: "ALL" as const,
  maxAttachmentSizeMb: 25,
  maxHuddleParticipants: 50,
};

@Injectable()
export class ChatOrgSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getSettings(orgId: string) {
    const row = await this.db.query.chatOrgSettings.findFirst({
      where: eq(chatOrgSettings.orgId, orgId),
    });
    if (row) return row;
    return { orgId, ...DEFAULT_CHAT_ORG_SETTINGS };
  }

  async updateSettings(orgId: string, userId: string, patch: UpdateChatOrgSettingsInput) {
    const existing = await this.db.query.chatOrgSettings.findFirst({
      where: eq(chatOrgSettings.orgId, orgId),
    });

    if (existing) {
      const [updated] = await this.db
        .update(chatOrgSettings)
        .set({ ...patch, updatedBy: userId })
        .where(eq(chatOrgSettings.orgId, orgId))
        .returning();
      return updated;
    }

    const [created] = await this.db
      .insert(chatOrgSettings)
      .values({ orgId, ...DEFAULT_CHAT_ORG_SETTINGS, ...patch, updatedBy: userId })
      .returning();
    return created;
  }
}
