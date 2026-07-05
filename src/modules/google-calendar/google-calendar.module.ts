import { Module } from "@nestjs/common";
import { GoogleCalendarInterviewsController } from "./google-calendar-interviews.controller";
import { GoogleCalendarService } from "./google-calendar.service";

@Module({
  controllers: [GoogleCalendarInterviewsController],
  providers: [GoogleCalendarService],
  exports: [GoogleCalendarService],
})
export class GoogleCalendarModule {}
