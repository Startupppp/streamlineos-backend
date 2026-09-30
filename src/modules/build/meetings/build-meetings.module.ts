import { Module } from "@nestjs/common";
import { MeetingsController } from "./meetings.controller";
import { MeetingsService } from "./meetings.service";
import { ActionItemsController } from "./action-items.controller";
import { ActionItemsService } from "./action-items.service";
import { ProjectsModule } from "../core";

@Module({
  imports: [ProjectsModule],
  controllers: [MeetingsController, ActionItemsController],
  providers: [MeetingsService, ActionItemsService],
})
export class BuildMeetingsModule {}
