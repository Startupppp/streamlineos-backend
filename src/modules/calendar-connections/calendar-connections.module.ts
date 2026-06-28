import { Module } from "@nestjs/common";
import { CalendarConnectionsController } from "./calendar-connections.controller";
import { CalendarConnectionsService } from "./calendar-connections.service";

@Module({
  controllers: [CalendarConnectionsController],
  providers: [CalendarConnectionsService],
  exports: [CalendarConnectionsService],
})
export class CalendarConnectionsModule {}
