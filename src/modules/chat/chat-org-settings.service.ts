import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { chatOrgSettings } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { UpdateChatOrgSettingsInput } from "./dto/chat.schemas";
import {
  chatOrgSettingsResponseSchema,
  type ChatOrgSettingsResponse,
} from "./dto/chat-org-settings-response.schema";

const DEFAULT_CHAT_ORG_SETTINGS = {
  defaultNotificationPreference: "ALL" as const,
  maxAttachmentSizeMb: 25,
  maxHuddleParticipants: 50,
};

@Injectable()
export class ChatOrgSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getSettings(orgId: string): Promise<ChatOrgSettingsResponse> {
    const row = await this.db.query.chatOrgSettings.findFirst({
      columns: {
        orgId: true,
        defaultNotificationPreference: true,
        maxAttachmentSizeMb: true,
        maxHuddleParticipants: true,
      },
      where: eq(chatOrgSettings.orgId, orgId),
    });
    if (row) return chatOrgSettingsResponseSchema.parse(row);
    return { orgId, ...DEFAULT_CHAT_ORG_SETTINGS };
  }

  async updateSettings(
    orgId: string,
    membershipId: number | null,
    patch: UpdateChatOrgSettingsInput,
  ): Promise<ChatOrgSettingsResponse> {
    const existing = await this.db.query.chatOrgSettings.findFirst({
      columns: { id: true },
      where: eq(chatOrgSettings.orgId, orgId),
    });

    if (existing) {
      const [updated] = await this.db
        .update(chatOrgSettings)
        .set({ ...patch, updatedByMembershipId: membershipId })
        .where(eq(chatOrgSettings.orgId, orgId))
        .returning({
          orgId: chatOrgSettings.orgId,
          defaultNotificationPreference: chatOrgSettings.defaultNotificationPreference,
          maxAttachmentSizeMb: chatOrgSettings.maxAttachmentSizeMb,
          maxHuddleParticipants: chatOrgSettings.maxHuddleParticipants,
        });
      return chatOrgSettingsResponseSchema.parse(updated);
    }

    const [created] = await this.db
      .insert(chatOrgSettings)
      .values({ orgId, ...DEFAULT_CHAT_ORG_SETTINGS, ...patch, updatedByMembershipId: membershipId })
      .returning({
        orgId: chatOrgSettings.orgId,
        defaultNotificationPreference: chatOrgSettings.defaultNotificationPreference,
        maxAttachmentSizeMb: chatOrgSettings.maxAttachmentSizeMb,
        maxHuddleParticipants: chatOrgSettings.maxHuddleParticipants,
      });
    return chatOrgSettingsResponseSchema.parse(created);
  }
}
