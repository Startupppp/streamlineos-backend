import { Module } from "@nestjs/common";
import { ChatChannelsController } from "./chat-channels.controller";
import { ChatMessagesController } from "./chat-messages.controller";
import { ChatPresenceController } from "./chat-presence.controller";
import { ChatTokenController } from "./chat-token.controller";
import { ChatPinsController } from "./chat-pins.controller";
import { ChatHuddlesController } from "./chat-huddles.controller";
import { ChatSearchController } from "./chat-search.controller";
import { ChatSavedController } from "./chat-saved.controller";
import { ChatLinkPreviewController } from "./chat-link-preview.controller";
import { ChatChannelsService } from "./chat-channels.service";
import { ChatMessagesService } from "./chat-messages.service";
import { ChatPresenceService } from "./chat-presence.service";
import { ChatTypingService } from "./chat-typing.service";
import { ChatPinsService } from "./chat-pins.service";
import { ChatHuddlesService } from "./chat-huddles.service";
import { ChatSearchService } from "./chat-search.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatSavedService } from "./chat-saved.service";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule],
  controllers: [ChatChannelsController, ChatMessagesController, ChatPresenceController, ChatTokenController, ChatPinsController, ChatHuddlesController, ChatSearchController, ChatSavedController, ChatLinkPreviewController],
  providers: [
    ChatChannelsService,
    ChatMessagesService,
    ChatPresenceService,
    ChatTypingService,
    ChatPinsService,
    ChatHuddlesService,
    ChatSearchService,
    ChatNotificationsService,
    ChatSavedService,
  ],
})
export class ChatModule {}
