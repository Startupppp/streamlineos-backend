import { Module } from "@nestjs/common";
import { ChatChannelsController } from "./chat-channels.controller";
import { ChatMessagesController } from "./chat-messages.controller";
import { ChatPresenceController } from "./chat-presence.controller";
import { ChatTokenController } from "./chat-token.controller";
import { ChatPinsController } from "./chat-pins.controller";
import { ChatChannelsService } from "./chat-channels.service";
import { ChatMessagesService } from "./chat-messages.service";
import { ChatPresenceService } from "./chat-presence.service";
import { ChatTypingService } from "./chat-typing.service";
import { ChatPinsService } from "./chat-pins.service";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule],
  controllers: [ChatChannelsController, ChatMessagesController, ChatPresenceController, ChatTokenController, ChatPinsController],
  providers: [
    ChatChannelsService,
    ChatMessagesService,
    ChatPresenceService,
    ChatTypingService,
    ChatPinsService,
  ],
})
export class ChatModule {}
