import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { ChatActionsController } from "./chat-actions.controller";
import { ChatEntityActionsController } from "./chat-entity-actions.controller";
import { ChatChannelsController } from "./chat-channels.controller";
import { ChatMessagesController } from "./chat-messages.controller";
import { ChatPresenceController } from "./chat-presence.controller";
import { ChatPinsController } from "./chat-pins.controller";
import { ChatHuddlesController } from "./chat-huddles.controller";
import { ChatSearchController } from "./chat-search.controller";
import { ChatSavedController } from "./chat-saved.controller";
import { ChatLinkPreviewController } from "./chat-link-preview.controller";
import { ChatInviteLinksController } from "./chat-invite-links.controller";
import { ChatOrgSettingsController } from "./chat-org-settings.controller";
import { ChatSummarizeController } from "./chat-summarize.controller";
import { ChatRealtimeController } from "./chat-realtime.controller";
import { ChatChannelsService } from "./chat-channels.service";
import { ChatChannelMembersService } from "./chat-channel-members.service";
import { ChatMessagesService } from "./chat-messages.service";
import { ChatMessageFanoutService } from "./chat-message-fanout.service";
import { ChatPresenceService } from "./chat-presence.service";
import { ChatTypingService } from "./chat-typing.service";
import { ChatPinsService } from "./chat-pins.service";
import { ChatHuddlesService } from "./chat-huddles.service";
import { ChatSearchService } from "./chat-search.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import { ChatSavedService } from "./chat-saved.service";
import { ChatInviteLinksService } from "./chat-invite-links.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { ChatSummarizeService } from "./chat-summarize.service";
import { RealtimeModule } from "../realtime/realtime.module";
import { EntityReferenceModule } from "../entity-reference/entity-reference.module";

@Module({
  imports: [BillingModule, RealtimeModule, EntityReferenceModule],
  controllers: [ChatActionsController,
    ChatEntityActionsController, ChatChannelsController, ChatMessagesController, ChatPresenceController, ChatPinsController, ChatHuddlesController, ChatSearchController, ChatSavedController, ChatLinkPreviewController, ChatInviteLinksController, ChatOrgSettingsController, ChatSummarizeController, ChatRealtimeController],
  providers: [
    ChatChannelsService,
    ChatChannelMembersService,
    ChatMessagesService,
    ChatMessageFanoutService,
    ChatPresenceService,
    ChatTypingService,
    ChatPinsService,
    ChatHuddlesService,
    ChatSearchService,
    ChatNotificationsService,
    ChatReplyRemindersService,
    ChatSavedService,
    ChatInviteLinksService,
    ChatOrgSettingsService,
    ChatSummarizeService,
  ],
  exports: [ChatReplyRemindersService, ChatChannelsService, ChatMessagesService, ChatSearchService],
})
export class ChatModule {}
