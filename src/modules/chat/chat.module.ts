import { Module } from "@nestjs/common";
import { ChatChannelsController } from "./chat-channels.controller";
import { ChatMessagesController } from "./chat-messages.controller";
import { ChatPresenceController } from "./chat-presence.controller";
import { ChatTokenController } from "./chat-token.controller";
import { ChatPinsController } from "./chat-pins.controller";
import { ChatHuddlesController } from "./chat-huddles.controller";
import { ChatChannelsService } from "./chat-channels.service";
import { ChatMessagesService } from "./chat-messages.service";
import { ChatPresenceService } from "./chat-presence.service";
import { ChatTypingService } from "./chat-typing.service";
import { ChatPinsService } from "./chat-pins.service";
import { ChatHuddlesService } from "./chat-huddles.service";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule],
  controllers: [ChatChannelsController, ChatMessagesController, ChatPresenceController, ChatTokenController, ChatPinsController, ChatHuddlesController],
  providers: [
    ChatChannelsService,
    ChatMessagesService,
    ChatPresenceService,
    ChatTypingService,
    ChatPinsService,
    ChatHuddlesService,
  ],
})
export class ChatModule {}
