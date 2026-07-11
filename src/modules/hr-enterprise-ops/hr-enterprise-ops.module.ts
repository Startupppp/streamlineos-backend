import { Module } from "@nestjs/common";
import { HrCoreModule } from "../hr-core/hr-core.module";
import { HrPoliciesModule } from "../hr-policies/hr-policies.module";
import { AccommodationsController } from "./accommodations/accommodations.controller";
import { EmergencyController } from "./emergency/emergency.controller";
import { IdentityController } from "./identity/identity.controller";
import { SimulatorController } from "./simulator/simulator.controller";
import { EventStreamController } from "./event-stream/event-stream.controller";
import { AccommodationsService } from "./accommodations/accommodations.service";
import { EmergencyService } from "./emergency/emergency.service";
import { IdentityService } from "./identity/identity.service";
import { SimulatorService } from "./simulator/simulator.service";
import { EventStreamService } from "./event-stream/event-stream.service";

@Module({
  imports: [HrCoreModule, HrPoliciesModule],
  controllers: [
    AccommodationsController,
    EmergencyController,
    IdentityController,
    SimulatorController,
    EventStreamController,
  ],
  providers: [
    AccommodationsService,
    EmergencyService,
    IdentityService,
    SimulatorService,
    EventStreamService,
  ],
  exports: [IdentityService, EventStreamService],
})
export class HrEnterpriseOpsModule {}
