import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import type { UpdateChannelInput } from "./dto/chat.schemas";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { AblyService } from "../realtime/ably.service";
import { ChatChannelMembersImplementation } from "./chat-channel-members-implementation";

@Injectable()
export class ChatChannelMembersService {
  private readonly implementation: ChatChannelMembersImplementation;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly entities: EntityReferenceService,
    private readonly ably: AblyService,
  ) {
    this.implementation = new ChatChannelMembersImplementation(db, cache, entities, ably);
  }

  async assertChannelMembership(channelId: number, userId: string, orgId: string): Promise<void> {
    return this.implementation.assertChannelMembership(channelId, userId, orgId);
  }
  async getChannel(channelId: number, userId: string, orgId: string) { return this.implementation.getChannel(channelId, userId, orgId); }
  async listMembers(channelId: number, userId: string, orgId: string) { return this.implementation.listMembers(channelId, userId, orgId); }
  async addMember(channelId: number, targetUserId: string, requesterId: string, orgId: string) { return this.implementation.addMember(channelId, targetUserId, requesterId, orgId); }
  async removeMember(channelId: number, targetUserId: string, requesterId: string, orgId: string) { return this.implementation.removeMember(channelId, targetUserId, requesterId, orgId); }
  async updateChannel(channelId: number, userId: string, body: UpdateChannelInput, orgId: string) { return this.implementation.updateChannel(channelId, userId, body, orgId); }
  async joinOpenChannel(channelId: number, actor: EntityActor) { return this.implementation.joinOpenChannel(channelId, actor); }
  async leaveChannel(channelId: number, userId: string, orgId: string) { return this.implementation.leaveChannel(channelId, userId, orgId); }
  async archiveChannel(channelId: number, userId: string, orgId: string) { return this.implementation.archiveChannel(channelId, userId, orgId); }
  async unarchiveChannel(channelId: number, userId: string, orgId: string) { return this.implementation.unarchiveChannel(channelId, userId, orgId); }
  async markRead(channelId: number, userId: string, orgId: string) { return this.implementation.markRead(channelId, userId, orgId); }
  async markChannelUnread(channelId: number, userId: string, orgId: string) { return this.implementation.markChannelUnread(channelId, userId, orgId); }
  async muteChannel(channelId: number, userId: string, duration: string, orgId: string) { return this.implementation.muteChannel(channelId, userId, duration, orgId); }
  async unmuteChannel(channelId: number, userId: string, orgId: string) { return this.implementation.unmuteChannel(channelId, userId, orgId); }
  async favoriteChannel(channelId: number, userId: string, orgId: string) { return this.implementation.favoriteChannel(channelId, userId, orgId); }
  async unfavoriteChannel(channelId: number, userId: string, orgId: string) { return this.implementation.unfavoriteChannel(channelId, userId, orgId); }
  async setNotificationPreference(channelId: number, userId: string, preference: string, orgId: string) { return this.implementation.setNotificationPreference(channelId, userId, preference, orgId); }
  async listChannelFiles(channelId: number, userId: string, orgId: string, cursor?: number, limit = 20) { return this.implementation.listChannelFiles(channelId, userId, orgId, cursor, limit); }
  async updateMemberRole(channelId: number, targetUserId: string, requesterId: string, orgId: string, role: string) { return this.implementation.updateMemberRole(channelId, targetUserId, requesterId, orgId, role); }
}
