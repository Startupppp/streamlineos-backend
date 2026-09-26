import { Module } from "@nestjs/common";
import { HrHelpdeskController } from "./hr-helpdesk.controller";
import { EmployeeSupportController } from "./employee-support.controller";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import { HrHelpdeskConfigService } from "./hr-helpdesk-config.service";
import { HrHelpdeskEscalationService } from "./hr-helpdesk-escalation.service";
import { HrCalendarController } from "./hr-calendar.controller";
import { HrCalendarService } from "./hr-calendar.service";
import { CelebrationsService } from "../directory/celebrations.service";
import { NotificationsModule } from "../../notifications/notifications.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { HrCoreModule } from "../core/hr-core.module";
import { KbCoreModule } from "../../kb/core/kb-core.module";
import { HrHelpdeskEventsConsumer } from "./hr-helpdesk-events.consumer";

@Module({
  imports: [NotificationsModule, OutboxModule, HrCoreModule, KbCoreModule],
  controllers: [HrHelpdeskController, EmployeeSupportController, HrCalendarController],
  providers: [
    HrHelpdeskService,
    HrHelpdeskConfigService,
    HrHelpdeskEscalationService,
    HrCalendarService,
    CelebrationsService,
    HrHelpdeskEventsConsumer,
  ],
  exports: [HrHelpdeskEscalationService],
})
export class HrHelpdeskModule {}
