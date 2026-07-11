import { Module } from "@nestjs/common";
import { HrHelpdeskController } from "./hr-helpdesk.controller";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import { HrCalendarController } from "./hr-calendar.controller";
import { HrCalendarService } from "./hr-calendar.service";
import { CelebrationsService } from "../hr-directory/celebrations.service";

@Module({
  controllers: [HrHelpdeskController, HrCalendarController],
  providers: [HrHelpdeskService, HrCalendarService, CelebrationsService],
})
export class HrHelpdeskModule {}
