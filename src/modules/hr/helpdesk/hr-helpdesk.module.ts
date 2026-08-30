import { Module } from "@nestjs/common";
import { HrHelpdeskController } from "./hr-helpdesk.controller";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import { HrCalendarController } from "./hr-calendar.controller";
import { HrCalendarService } from "./hr-calendar.service";
import { CelebrationsService } from "../directory/celebrations.service";
import { NotificationsModule } from "../../notifications/notifications.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { HrHelpdeskEventsConsumer } from "./hr-helpdesk-events.consumer";

@Module({
  imports: [NotificationsModule, OutboxModule],
  controllers: [HrHelpdeskController, HrCalendarController],
  providers: [HrHelpdeskService, HrCalendarService, CelebrationsService, HrHelpdeskEventsConsumer],
})
export class HrHelpdeskModule {}
