import { Module } from "@nestjs/common";
import { GoogleCalendarController } from "./google-calendar.controller";
import { GoogleCalendarInterviewsController } from "./google-calendar-interviews.controller";
import { GoogleCalendarService } from "./google-calendar.service";

@Module({
  controllers: [GoogleCalendarController, GoogleCalendarInterviewsController],
  providers: [GoogleCalendarService],
  exports: [GoogleCalendarService],
})
export class GoogleCalendarModule {}
