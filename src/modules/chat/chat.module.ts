import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { NotificationsModule } from "../notifications/notifications.module";
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
import { ChatMessageTimelineService } from "./chat-message-timeline.service";
import { ChatReactionsService } from "./chat-reactions.service";
import { ChatMessageFanoutService } from "./chat-message-fanout.service";
import { ChatPresenceService } from "./chat-presence.service";
import { ChatTypingService } from "./chat-typing.service";
import { ChatPinsService } from "./chat-pins.service";
import { ChatHuddlesService } from "./chat-huddles.service";
import { ChatHuddleSignalsService } from "./chat-huddle-signals.service";
import { ChatSearchService } from "./chat-search.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import { ChatSavedService } from "./chat-saved.service";
import { ChatInviteLinksService } from "./chat-invite-links.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { ChatSummarizeService } from "./chat-summarize.service";
import { RealtimeModule } from "../realtime/realtime.module";
import { EntityReferenceModule } from "../entity-reference/entity-reference.module";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { ChatFanoutOutboxConsumer } from "./chat-fanout-outbox.consumer";
import { MESSAGE_FANOUT_PROVIDER } from "./message-fanout.interface";
import { OutboxBackedMessageFanoutProvider } from "./outbox-backed-message-fanout.provider";

@Module({
  imports: [BillingModule, NotificationsModule, RealtimeModule, EntityReferenceModule, OutboxModule],
  controllers: [
    ChatActionsController,
    ChatEntityActionsController,
    ChatChannelsController,
    ChatMessagesController,
    ChatPresenceController,
    ChatPinsController,
    ChatHuddlesController,
    ChatSearchController,
    ChatSavedController,
    ChatLinkPreviewController,
    ChatInviteLinksController,
    ChatOrgSettingsController,
    ChatSummarizeController,
    ChatRealtimeController,
  ],
  providers: [
    ChatMessageFanoutService,
    OutboxBackedMessageFanoutProvider,
    { provide: MESSAGE_FANOUT_PROVIDER, useExisting: OutboxBackedMessageFanoutProvider },
    ChatFanoutOutboxConsumer,
    ChatChannelsService,
    ChatChannelMembersService,
    ChatMessagesService,
    ChatMessageTimelineService,
    ChatReactionsService,
    ChatPresenceService,
    ChatTypingService,
    ChatPinsService,
    ChatHuddlesService,
    ChatHuddleSignalsService,
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
